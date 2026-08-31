import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const WORKER_ID = "busyworker001";
const ROOT_ACTIVE_SESSION_ID = "01a031af-95c1-728f-8b57-d5cc9f0b80e9";

interface SupervisorInternals {
	start(): Promise<void>;
	workers: Map<string, { descriptor: { lifecycle: string; lastError?: string }; failedReprobe?: Promise<void> }>;
	catalog: {
		start(): Promise<void>;
		list(): Promise<unknown[]>;
		markInterrupted(sessionPath: string, activeSessionId: string, operations: string[]): Promise<void>;
	};
	cleanupSupervisorResources(): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

function spawnLongRunningChild(): ChildProcess {
	const child = spawn("sleep", ["300"], { stdio: "ignore" });
	cleanups.push(() => {
		if (child.pid !== undefined && isAlive(child.pid)) child.kill("SIGKILL");
	});
	return child;
}

async function spawnExitedPid(): Promise<number> {
	const child = spawn("true", [], { stdio: "ignore" });
	await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	return child.pid!;
}

interface Harness {
	supervisor: SupervisorInternals;
	orphanJournalPath: string;
	sessionFile: string;
	kernel: ChildProcess;
	markInterrupted: ReturnType<typeof vi.fn>;
}

/**
 * A worker whose socket accepts connections but never answers, with one live
 * kernel child journaled as its orphan and one busy operation in its recovery
 * journal -- the shape of a healthy worker mid-turn that is just too busy to
 * answer the supervisor, or of a dead one, depending on `workerPid`.
 */
async function setUp(workerPid: number, workerProcessStartId: string | undefined): Promise<Harness> {
	const directory = mkdtempSync(join(tmpdir(), "pa-live-reap-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const socketPath = join(directory, "d.sock");
	const workerSocketPath = join(directory, "w.sock");
	const descriptorDir = join(directory, "workers");
	mkdirSync(descriptorDir, { recursive: true });
	const sessionFile = join(directory, "root.jsonl");
	writeFileSync(sessionFile, "");

	const listener: Server = createServer(() => {});
	await new Promise<void>((resolveListen, rejectListen) => {
		listener.once("error", rejectListen);
		listener.listen(workerSocketPath, resolveListen);
	});
	cleanups.push(() => new Promise<void>((resolveClose) => listener.close(() => resolveClose())));

	const kernel = spawnLongRunningChild();
	await waitFor(() => kernel.pid !== undefined && getProcessStartId(kernel.pid) !== undefined, 5_000);
	const now = new Date().toISOString();
	const orphanJournalPath = join(descriptorDir, `${WORKER_ID}.orphans.jsonl`);
	writeFileSync(
		orphanJournalPath,
		`${JSON.stringify({
			version: 1,
			pid: kernel.pid,
			ownerPid: workerPid,
			processStartId: getProcessStartId(kernel.pid!),
			active: true,
			recordedAt: now,
		})}\n`,
	);
	writeFileSync(
		join(descriptorDir, `${WORKER_ID}.recovery.jsonl`),
		`${JSON.stringify({
			version: 1,
			activeSessionId: ROOT_ACTIVE_SESSION_ID,
			sessionId: "01a031af-0000-7000-8000-000000000001",
			sessionFile,
			busy: true,
			operation: "message_start",
			recordedAt: now,
		})}\n`,
	);
	writeFileSync(
		join(descriptorDir, `${WORKER_ID}.json`),
		JSON.stringify({
			version: 2,
			supervisorSocketPath: socketPath,
			workerId: WORKER_ID,
			pid: workerPid,
			...(workerProcessStartId ? { processStartId: workerProcessStartId } : {}),
			socketPath: workerSocketPath,
			authenticationToken: "test-token",
			rootActiveSessionId: ROOT_ACTIVE_SESSION_ID,
			sessionFile,
			createdAt: now,
			updatedAt: now,
			consecutiveFailures: 0,
			createCommand: { type: "create", sessionPath: sessionFile },
		}),
	);

	vi.stubEnv(REGISTRY_DIR_ENV, join(directory, "registry"));
	cleanups.push(() => {
		vi.unstubAllEnvs();
	});
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	cleanups.push(() => {
		logged.mockRestore();
	});

	const supervisor = new DaemonSupervisor(socketPath, {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir,
	}) as unknown as SupervisorInternals;
	const markInterrupted = vi.fn(async () => {});
	supervisor.catalog = { start: async () => {}, list: async () => [], markInterrupted };
	cleanups.push(() => supervisor.cleanupSupervisorResources());
	await supervisor.start();
	return { supervisor, orphanJournalPath, sessionFile, kernel, markInterrupted };
}

describe("writing off a worker that stopped answering", () => {
	it.skipIf(process.platform === "win32")(
		"leaves a live worker's kernels and transcripts alone",
		async () => {
			const harness = await setUp(process.pid, getProcessStartId(process.pid));
			const worker = () => harness.supervisor.workers.get(WORKER_ID);

			await waitFor(() => worker()?.descriptor.lifecycle === "failed", 60_000);
			expect(worker()?.descriptor.lifecycle).toBe("failed");
			expect(worker()?.descriptor.lastError).toBe("Session worker is alive but not answering");
			expect(worker()?.failedReprobe).toBeDefined();

			// The worker is alive and still owns its kernel: the supervisor must not
			// have reaped it (the worker's next kernel write would fail with EPIPE
			// and crash it) nor stamped the transcript as interrupted underneath it.
			expect(isAlive(harness.kernel.pid!)).toBe(true);
			expect(existsSync(harness.orphanJournalPath)).toBe(true);
			expect(readFileSync(harness.orphanJournalPath, "utf8")).toContain('"active":true');
			expect(harness.markInterrupted).not.toHaveBeenCalled();
		},
		120_000,
	);

	it.skipIf(process.platform === "win32")(
		"still reaps the kernels and marks the transcript of a dead worker",
		async () => {
			const harness = await setUp(await spawnExitedPid(), "ps:never-again");
			const worker = () => harness.supervisor.workers.get(WORKER_ID);

			await waitFor(() => worker()?.descriptor.lifecycle === "failed", 30_000);
			expect(worker()?.descriptor.lifecycle).toBe("failed");
			expect(worker()?.descriptor.lastError).toBe("Waiting for a client with fresh runtime context");

			await waitFor(() => !isAlive(harness.kernel.pid!), 5_000);
			expect(isAlive(harness.kernel.pid!)).toBe(false);
			expect(existsSync(harness.orphanJournalPath)).toBe(false);
			expect(harness.markInterrupted).toHaveBeenCalledWith(harness.sessionFile, ROOT_ACTIVE_SESSION_ID, [
				"message_start",
			]);
		},
		60_000,
	);
});

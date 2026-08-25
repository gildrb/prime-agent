import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const WORKER_ID = "sleptworker01";

interface SupervisorInternals {
	start(): Promise<void>;
	workers: Map<string, { descriptor: { lifecycle: string }; failedReprobe?: Promise<void> }>;
	catalog: { start(): Promise<void>; list(): Promise<unknown[]> };
	cleanupSupervisorResources(): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

function lifecycle(supervisor: SupervisorInternals): string | undefined {
	return supervisor.workers.get(WORKER_ID)?.descriptor.lifecycle;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

describe("failed worker re-probe", () => {
	it.skipIf(process.platform === "win32")(
		"re-adopts a worker that starts answering again after being written off",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "pa-reprobe-"));
			cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
			const socketPath = join(directory, "d.sock");
			const workerSocketPath = join(directory, "w.sock");
			const descriptorDir = join(directory, "workers");
			mkdirSync(descriptorDir, { recursive: true });

			// Phase one: a worker that accepts connections and answers nothing. This is
			// what a suspended host looks like to the supervisor -- the process is alive
			// and its socket completes connections, but no reply ever comes, so the
			// retry ladder writes the worker off as failed.
			let listener: Server = createServer(() => {});
			const listen = (server: Server) =>
				new Promise<void>((resolveListen, rejectListen) => {
					server.once("error", rejectListen);
					server.listen(workerSocketPath, resolveListen);
				});
			await listen(listener);
			cleanups.push(() => new Promise<void>((resolveClose) => listener.close(() => resolveClose())));

			const now = new Date().toISOString();
			writeFileSync(
				join(descriptorDir, `${WORKER_ID}.json`),
				JSON.stringify({
					version: 2,
					supervisorSocketPath: socketPath,
					workerId: WORKER_ID,
					pid: process.pid,
					processStartId: getProcessStartId(process.pid),
					socketPath: workerSocketPath,
					authenticationToken: "test-token",
					rootActiveSessionId: "01a031af-95c1-728f-8b57-d5cc9f0b80e9",
					createdAt: now,
					updatedAt: now,
					consecutiveFailures: 0,
					createCommand: { type: "create", noSession: true },
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
			supervisor.catalog = { start: async () => {}, list: async () => [] };
			cleanups.push(() => supervisor.cleanupSupervisorResources());

			await supervisor.start();

			// The ladder runs to exhaustion and gives up on a process that is alive.
			await waitFor(() => lifecycle(supervisor) === "failed", 60_000);
			expect(lifecycle(supervisor)).toBe("failed");

			// The write-off must not be the end of it: the process is still alive with
			// a matching start id, so a re-probe has to be pending.
			expect(supervisor.workers.get(WORKER_ID)?.failedReprobe).toBeDefined();

			// Phase two: the host wakes and the worker answers again. Nothing else
			// prods the supervisor -- no client attaches, no restart happens.
			await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
			listener = createServer((socket) => {
				socket.on("data", () => socket.destroy());
			});
			await listen(listener);

			// Without the re-probe this stays "failed" forever and every session the
			// worker holds keeps answering "Unknown active session".
			await waitFor(() => lifecycle(supervisor) !== "failed", 90_000);
			expect(lifecycle(supervisor)).not.toBe("failed");
		},
		180_000,
	);
});

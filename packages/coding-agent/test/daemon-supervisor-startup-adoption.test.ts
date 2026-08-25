import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const WORKER_ID = "wedgedworker1";

interface SupervisorInternals {
	start(): Promise<void>;
	workers: Map<string, { descriptor: { lifecycle: string } }>;
	catalog: { start(): Promise<void>; list(): Promise<unknown[]> };
	cleanupSupervisorResources(): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

function workerLifecycle(supervisor: SupervisorInternals): string | undefined {
	return supervisor.workers.get(WORKER_ID)?.descriptor.lifecycle;
}

describe("daemon supervisor startup adoption", () => {
	it.skipIf(process.platform === "win32")(
		"listens while an unresponsive worker is still recovering",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "pa-adopt-"));
			cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
			const socketPath = join(directory, "d.sock");
			const workerSocketPath = join(directory, "w.sock");
			const descriptorDir = join(directory, "workers");
			mkdirSync(descriptorDir, { recursive: true });

			// A worker that accepts connections and then answers nothing: alive,
			// reachable, and wedged -- the state that costs adoption its whole
			// connect/list retry ladder.
			const worker = createServer(() => {});
			await new Promise<void>((resolve, reject) => {
				worker.once("error", reject);
				worker.listen(workerSocketPath, resolve);
			});
			cleanups.push(() => new Promise<void>((resolve) => worker.close(() => resolve())));

			// The descriptor points at this test process: alive with a matching
			// start id, so the supervisor must walk that ladder instead of writing
			// the worker off as gone. Nothing kills it -- a descriptor loaded from
			// disk carries no launchEnv, so recovery stops at "waiting for a client
			// with fresh runtime context".
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
					rootActiveSessionId: "01a00725-fbc1-7722-aa5a-df083af76bf8",
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

			const startup = supervisor.start();

			// A client that arrives mid-adoption must be greeted. daemon_hello is the
			// only signal that separates a booting supervisor from a stale one, and a
			// client that reads "stale" shuts this supervisor down and spawns a rival.
			// Retry the connect: start() reaches listen() asynchronously.
			const greeting = (async (): Promise<Record<string, unknown>> => {
				const deadline = Date.now() + 60_000;
				while (Date.now() < deadline) {
					const line = await new Promise<string | undefined>((resolveLine) => {
						const probe = createConnection(socketPath);
						cleanups.push(() => {
							probe.destroy();
						});
						let buffered = "";
						const finish = (value?: string) => {
							probe.destroy();
							resolveLine(value);
						};
						probe.once("error", () => finish());
						probe.once("close", () => finish());
						probe.on("data", (chunk) => {
							buffered += String(chunk);
							const newline = buffered.indexOf("\n");
							if (newline !== -1) finish(buffered.slice(0, newline));
						});
					});
					if (line) return JSON.parse(line) as Record<string, unknown>;
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
				}
				throw new Error("supervisor sent no daemon_hello");
			})();
			const greetedDuringStartup = await Promise.race([greeting.then(() => true), startup.then(() => false)]);

			await startup;

			expect(greetedDuringStartup).toBe(true);
			expect(await greeting).toMatchObject({ type: "daemon_hello", socketPath });

			// Without the startup budget, start() awaited the full ladder: the
			// supervisor held the exclusive socket-path lock and withheld
			// daemon_hello the whole time, so every rival CLI gave up connecting,
			// spawned another supervisor, and that one died on the lock.
			expect(workerLifecycle(supervisor)).toBe("recovering");
			expect(logged.mock.calls.flat().join("\n")).toContain(`still recovering`);

			// The abandoned adoption still has to finish on its own.
			const deadline = Date.now() + 30_000;
			while (workerLifecycle(supervisor) === "recovering" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(workerLifecycle(supervisor)).toBe("failed");
		},
		90_000,
	);
});

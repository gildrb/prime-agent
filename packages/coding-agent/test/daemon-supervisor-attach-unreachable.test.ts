import { describe, expect, it } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface AttachCapableSupervisor {
	attachClient(client: unknown, command: { type: "attach"; activeSessionId: string }): Promise<unknown>;
}

function makeClient(id = "reconnecting-client") {
	return {
		id,
		capabilities: new Set<string>(),
		supportsExtensionUi: false,
		attachedActiveSessionIds: new Set<string>(),
	};
}

function makeSupervisor(worker: Record<string, unknown>, client = makeClient()): AttachCapableSupervisor {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map([[(worker.descriptor as { workerId: string }).workerId, worker]]),
		clients: new Set([client]),
		protocolClientIds: new Map(),
	}) as AttachCapableSupervisor;
}

function makeWorker(descriptor: Record<string, unknown>) {
	return {
		descriptor: {
			workerId: "worker-1",
			rootActiveSessionId: "active-1",
			rootSessionId: "01a0-session-1",
			pid: 1234,
			createCommand: { type: "create" },
			...descriptor,
		},
		summaries: new Map(),
		client: undefined,
		intentionalStop: false,
	};
}

describe("attach to a session whose worker is not reachable", () => {
	it("reports a worker still being recovered instead of an unknown session", async () => {
		const supervisor = makeSupervisor(makeWorker({ lifecycle: "recovering" }));

		await expect(
			supervisor.attachClient(makeClient(), { type: "attach", activeSessionId: "active-1" }),
		).rejects.toThrow("Session worker is recovering");
	});

	it("reports a dead worker as failed so the client can resume from the transcript", async () => {
		const supervisor = makeSupervisor(
			makeWorker({ lifecycle: "failed", lastError: "Waiting for a client with fresh runtime context" }),
		);

		await expect(
			supervisor.attachClient(makeClient(), { type: "attach", activeSessionId: "active-1" }),
		).rejects.toThrow("Session worker is failed");
	});

	it("matches the root session id as well as the active session id", async () => {
		const supervisor = makeSupervisor(makeWorker({ lifecycle: "failed" }));

		await expect(
			supervisor.attachClient(makeClient(), { type: "attach", activeSessionId: "01a0-session-1" }),
		).rejects.toThrow("Session worker is failed");
	});

	it.skipIf(process.platform === "win32")(
		"keeps a written-off worker whose process is alive attachable as recovering",
		async () => {
			// The retry ladder gave up on this worker, but its process is alive with
			// the recorded start id, so a re-probe is pending: a client must keep
			// retrying rather than resume the transcript in a fresh worker.
			const supervisor = makeSupervisor(
				makeWorker({
					lifecycle: "failed",
					lastError: "Session worker is alive but not answering",
					pid: process.pid,
					processStartId: getProcessStartId(process.pid),
				}),
			);

			await expect(
				supervisor.attachClient(makeClient(), { type: "attach", activeSessionId: "active-1" }),
			).rejects.toThrow("Session worker is recovering");
		},
	);

	it("still hides sessions owned by another client", async () => {
		const supervisor = makeSupervisor(makeWorker({ lifecycle: "failed", ownerClientId: "owner-client" }));

		await expect(
			supervisor.attachClient(makeClient("other-client"), { type: "attach", activeSessionId: "active-1" }),
		).rejects.toThrow("Unknown active session: active-1");
	});

	it("leaves genuinely unknown sessions unknown", async () => {
		const supervisor = makeSupervisor(makeWorker({ lifecycle: "failed" }));

		await expect(
			supervisor.attachClient(makeClient(), { type: "attach", activeSessionId: "never-existed" }),
		).rejects.toThrow("Unknown active session: never-existed");
	});
});

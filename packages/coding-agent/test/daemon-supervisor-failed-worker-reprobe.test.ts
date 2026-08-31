import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface RecoveryWorker {
	descriptor: {
		workerId: string;
		pid: number;
		processStartId?: string;
		rootActiveSessionId?: string;
		rootSessionId?: string;
		sessionFile?: string;
		createCommand?: { type: "create"; sessionPath?: string; noSession?: boolean };
		lifecycle: string;
	};
	intentionalStop: boolean;
	recovery?: Promise<void>;
	failedReprobe?: Promise<void>;
	client?: object;
	summaries?: Map<string, SessionSummary>;
}

interface SupervisorInternals {
	workers: Map<string, RecoveryWorker>;
	shuttingDown: boolean;
	assertRecoveryAllowed(): Promise<void>;
	persistWorker(worker: RecoveryWorker): void;
	recoverWorker(worker: RecoveryWorker): Promise<void>;
	scheduleFailedWorkerReprobe(worker: RecoveryWorker): void;
	log(message: string): void;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("failed worker re-probe", () => {
	it("keeps probing past the initial backoff sequence until the worker answers", async () => {
		vi.useFakeTimers();
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "sleptworker01",
				pid: process.pid,
				processStartId: getProcessStartId(process.pid),
				lifecycle: "recovering",
			},
			intentionalStop: false,
		};
		let attempts = 0;
		const attemptTimes: number[] = [];
		const recoverWorker = vi.fn(async (target: RecoveryWorker) => {
			attempts++;
			attemptTimes.push(Date.now());
			if (attempts === 9) {
				target.client = {};
				target.descriptor.lifecycle = "ready";
			} else {
				target.descriptor.lifecycle = "recovering";
			}
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			processIdentity: vi.fn().mockReturnValueOnce("gone").mockReturnValue("unknown"),
			assertRecoveryAllowed: vi.fn(async () => {}),
			persistWorker: vi.fn(),
			recoverWorker,
			log: vi.fn(),
		}) as SupervisorInternals;

		supervisor.scheduleFailedWorkerReprobe(worker);
		const reprobe = worker.failedReprobe;
		expect(reprobe).toBeDefined();
		for (let attempt = 0; attempt < 9; attempt++) {
			await vi.advanceTimersToNextTimerAsync();
		}
		await reprobe;

		expect(recoverWorker).toHaveBeenCalledTimes(9);
		const reprobeGaps = attemptTimes.slice(1).map((time, index) => time - attemptTimes[index]!);
		expect(Math.max(...reprobeGaps)).toBeLessThanOrEqual(30_000);
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(worker.client).toBeDefined();
	});

	it("restores passive-child routing from the first successful full-roster reprobe", async () => {
		vi.useFakeTimers();
		const root = {
			id: "active-root",
			activeSessionId: "active-root",
			sessionId: "root-session",
			cwd: "/tmp",
			sessionFile: "/tmp/root.jsonl",
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		} satisfies SessionSummary;
		const passiveChild = {
			id: "passive-child",
			sessionId: "child-session",
			cwd: "/tmp",
			sessionFile: "/tmp/child.jsonl",
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			parentSessionId: "root-session",
			rlmChildId: "child-1",
		} satisfies SessionSummary;
		const request = vi.fn(async () => success(undefined, "list", { sessions: [root, passiveChild] }));
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "routing-reprobe",
				pid: process.pid,
				processStartId: getProcessStartId(process.pid),
				rootActiveSessionId: root.activeSessionId,
				createCommand: { type: "create" },
				lifecycle: "recovering",
			},
			intentionalStop: false,
			summaries: new Map(),
		};
		let supervisor: SupervisorInternals & {
			refreshWorkerSummaries(target: RecoveryWorker, recovery: boolean): Promise<void>;
			findSummaryInWorker(target: RecoveryWorker, selector: string): SessionSummary | undefined;
			streamReconstructor: { seed: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
		};
		const recoverWorker = vi.fn(async (target: RecoveryWorker) => {
			target.client = { request };
			await supervisor.refreshWorkerSummaries(target, true);
			target.descriptor.lifecycle = "ready";
		});
		supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => {}),
			persistWorker: vi.fn(),
			recoverWorker,
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
			log: vi.fn(),
		}) as typeof supervisor;

		supervisor.scheduleFailedWorkerReprobe(worker);
		const reprobe = worker.failedReprobe!;
		await vi.advanceTimersToNextTimerAsync();
		await reprobe;

		expect(request).toHaveBeenCalledWith({ type: "list" }, 15_000);
		expect(worker.summaries?.get(passiveChild.id)).toBe(passiveChild);
		expect(supervisor.findSummaryInWorker(worker, passiveChild.id)).toBe(passiveChild);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonWorkerClient, DaemonWorkerRequestTimeoutError } from "../src/modes/daemon/daemon-worker-client.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("DaemonWorkerClient", () => {
	it("classifies request timeouts by command", async () => {
		vi.useFakeTimers();
		const client = new DaemonWorkerClient("/tmp/worker.sock");
		const channel = { send: vi.fn(async () => {}), close: vi.fn() };
		const socket = { destroyed: false, destroy: vi.fn() };
		Object.assign(client, { channel, socket });

		const outcome = client.request({ type: "list" }, 100).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(100);

		const error = await outcome;
		expect(error).toBeInstanceOf(DaemonWorkerRequestTimeoutError);
		expect(error).toMatchObject({ command: "list" });
		client.close();
	});
});

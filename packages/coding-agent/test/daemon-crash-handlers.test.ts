import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installDaemonCrashHandlers } from "../src/modes/daemon/daemon-crash-handlers.js";

type Target = Parameters<typeof installDaemonCrashHandlers>[1];

function fakeProcess() {
	return Object.assign(new EventEmitter(), { exit: vi.fn() });
}

describe("installDaemonCrashHandlers", () => {
	it("logs the stack of an uncaught exception before exiting", () => {
		const target = fakeProcess();
		const log = vi.fn();
		installDaemonCrashHandlers(log, target as unknown as Target);

		target.emit("uncaughtException", new Error("boom"));

		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toMatch(/^uncaught exception: Error: boom\n\s+at /);
		expect(target.exit).toHaveBeenCalledWith(1);
	});

	it("logs unhandled rejections, including non-Error reasons", () => {
		const target = fakeProcess();
		const log = vi.fn();
		installDaemonCrashHandlers(log, target as unknown as Target);

		target.emit("unhandledRejection", "nope");

		expect(log).toHaveBeenCalledWith("unhandled rejection: nope");
		expect(target.exit).toHaveBeenCalledWith(1);
	});

	it("retains a mutated error code that is absent from the original stack", () => {
		const target = fakeProcess();
		const log = vi.fn();
		installDaemonCrashHandlers(log, target as unknown as Target);
		const error = Object.assign(new Error("lock update failed"), {
			code: "ECOMPROMISED",
			stack: "Error: lock update failed",
		});

		target.emit("uncaughtException", error);

		expect(log).toHaveBeenCalledWith("uncaught exception: Error: lock update failed\ncode: ECOMPROMISED");
		expect(target.exit).toHaveBeenCalledWith(1);
	});

	it("uninstalls both handlers", () => {
		const target = fakeProcess();
		const uninstall = installDaemonCrashHandlers(vi.fn(), target as unknown as Target);
		expect(target.listenerCount("uncaughtException")).toBe(1);
		expect(target.listenerCount("unhandledRejection")).toBe(1);

		uninstall();

		expect(target.listenerCount("uncaughtException")).toBe(0);
		expect(target.listenerCount("unhandledRejection")).toBe(0);
	});
});

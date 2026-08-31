import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { DAEMON_CATALOG_LOG_PATH_ENV, resolveCatalogSessionMatch } from "../src/modes/daemon/daemon-catalog-process.js";

function session(id: string, name: string | undefined, path: string): SessionInfo {
	return {
		id,
		name,
		path,
		cwd: "/tmp/project",
		rlmDepth: 0,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

describe("daemon catalog selector resolution", () => {
	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			session("named-session-id", "target", "/tmp/by-name.jsonl"),
			session("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
	});

	it("logs an uncaught catalog error before exiting", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-catalog-crash-"));
		const logPath = join(directory, "daemon.log");
		const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
		const fixturePath = resolve(__dirname, "fixtures/catalog-crash.ts");
		try {
			const child = spawn(process.execPath, [tsxPath, fixturePath], {
				env: {
					...process.env,
					[DAEMON_CATALOG_LOG_PATH_ENV]: logPath,
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
				child.once("error", rejectExit);
				child.once("exit", resolveExit);
			});

			expect(exitCode).toBe(1);
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("uncaught exception: Error: catalog crash fixture");
			expect(log).toContain("code: ECATALOGTEST");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

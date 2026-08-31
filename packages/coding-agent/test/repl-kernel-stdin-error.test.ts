import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

/**
 * A kernel that closes its end of the request pipe on demand but stays alive,
 * so the host's next request write fails with EPIPE rather than being refused
 * up front by an already-destroyed stream after the exit.
 */
function writeFakeRuntime(path: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "ready", protocol: 3, python: process.version });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute" && request.code === "close-stdin") {
    // Acknowledge this request, then close the descriptor itself: destroying
    // the stream leaves the pipe open and would not make the next write fail.
    emit({ event: "done", id: request.id, status: "ok" });
    process.stdin.on("error", () => {});
    input.close();
    process.stdin.pause();
    fs.closeSync(0);
    setInterval(() => {}, 1000);
    return;
  }
  if (request.type === "execute") {
    emit({ event: "done", id: request.id, status: "ok" });
    return;
  }
  if (request.type === "shutdown") {
    emit({ event: "done", id: request.id, status: "ok" });
    process.exit(0);
  }
});
`,
	);
	chmodSync(path, 0o755);
}

describe("ReplKernelManager kernel stdin errors", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-stdin-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it.skipIf(process.platform === "win32")("survives EPIPE on a request write", async () => {
		const python = join(tempDir, "python");
		writeFakeRuntime(python);
		const manager = new ReplKernelManager({ python, cwd: tempDir, env: {} });
		try {
			await expect(manager.execute("close-stdin")).resolves.toMatchObject({ status: "ok" });

			// Without an "error" listener on the kernel's stdin this write turns into
			// an uncaught exception that kills the host process outright.
			await expect(manager.execute("after-close")).rejects.toThrow(/EPIPE|shut down/);
		} finally {
			await manager.kill();
		}
	});
});

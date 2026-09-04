import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VIRTUAL_MODULES } from "../src/core/extensions/bundled-modules.js";

const fixturePath = fileURLToPath(new URL("./fixtures/virtual-modules-peerless-extension.js", import.meta.url));

interface PeerlessExtension {
	(): void;
	piAiBindings: {
		root: Record<string, unknown>;
		compat: Record<string, unknown>;
	};
	compatStringEnumSchema: unknown;
	hostBindings: Record<string, unknown>;
}

let tempDir: string;
let extension: PeerlessExtension;

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peerless-extension-"));
	const peerlessFixture = path.join(tempDir, "extension.js");
	fs.copyFileSync(fixturePath, peerlessFixture);

	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		virtualModules: VIRTUAL_MODULES,
		tryNative: false,
	});
	extension = (await jiti.import(peerlessFixture, { default: true })) as PeerlessExtension;
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("extension virtual modules", () => {
	it("loads the host pi-ai root and compat API without extension peers", () => {
		expect(fs.existsSync(path.join(tempDir, "node_modules"))).toBe(false);
		expect(VIRTUAL_MODULES["@earendil-works/pi-ai/compat"]).toBe(VIRTUAL_MODULES["@earendil-works/pi-ai"]);

		const hostPiAi = VIRTUAL_MODULES["@earendil-works/pi-ai"] as Record<string, unknown>;
		for (const exportName of ["complete", "completeSimple", "StringEnum"] as const) {
			expect(extension.piAiBindings.root[exportName], `root ${exportName}`).toBe(hostPiAi[exportName]);
			expect(extension.piAiBindings.compat[exportName], `compat ${exportName}`).toBe(hostPiAi[exportName]);
		}
		expect(extension.compatStringEnumSchema).toMatchObject({ type: "string", enum: ["x"] });
	});

	it("keeps the existing extension peer modules host-provided", () => {
		for (const [specifier, exportName] of [
			["@earendil-works/pi-agent-core", "Agent"],
			["@earendil-works/pi-ai/oauth", "getOAuthProvider"],
			["@earendil-works/pi-tui", "TUI"],
			["@earendil-works/pi-coding-agent", "createEventBus"],
			["@mariozechner/pi-agent-core", "Agent"],
			["@mariozechner/pi-ai", "getModel"],
			["@mariozechner/pi-ai/oauth", "getOAuthProvider"],
			["@mariozechner/pi-tui", "TUI"],
			["@mariozechner/pi-coding-agent", "createEventBus"],
			["typebox", "Type"],
			["typebox/compile", "Compile"],
			["typebox/value", "Value"],
			["@sinclair/typebox", "Type"],
			["@sinclair/typebox/compile", "Compile"],
			["@sinclair/typebox/value", "Value"],
		] as const) {
			expect(extension.hostBindings[specifier], specifier).toBe(
				(VIRTUAL_MODULES[specifier] as Record<string, unknown>)[exportName],
			);
		}
	});
});

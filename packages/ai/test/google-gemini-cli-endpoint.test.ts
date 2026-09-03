import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGoogleGeminiCli, streamSimpleGoogleGeminiCli } from "../src/providers/google-gemini-cli.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;

const createSseResponse = () => {
	const body = `data: ${JSON.stringify({
		response: {
			candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
		},
	})}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("google-gemini-cli Antigravity endpoints", () => {
	it("uses the production daily endpoint before the sandbox fallback", async () => {
		const urls: string[] = [];
		const payloads: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			urls.push(input.toString());
			payloads.push(JSON.parse(String(init?.body)));
			if (urls.length === 1) {
				return new Response("Forbidden", { status: 403 });
			}
			return createSseResponse();
		});
		global.fetch = fetchMock as typeof fetch;

		const model: Model<"google-gemini-cli"> = {
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const context: Context = {
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const stream = streamGoogleGeminiCli(model, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "project" }),
			sessionId: "session-1",
		});
		for await (const _event of stream) {
			// exhaust stream
		}
		await stream.result();

		expect(urls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
		expect(payloads[0]?.request).toMatchObject({ session_id: "session-1" });
		expect(payloads[0]?.request).not.toHaveProperty("sessionId");
	});

	it("advances to the next Antigravity endpoint after a network error", async () => {
		const urls: string[] = [];
		global.fetch = vi.fn(async (input) => {
			urls.push(String(input));
			if (urls.length === 1) throw new TypeError("fetch failed");
			return createSseResponse();
		}) as typeof fetch;
		const model: Model<"google-gemini-cli"> = {
			id: "gemini-3.8-flash-high",
			name: "Gemini 3.8 Flash (High)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		};
		const stream = streamGoogleGeminiCli(
			model,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: JSON.stringify({ token: "token", projectId: "project" }) },
		);
		for await (const _event of stream) {
			// exhaust stream
		}
		await stream.result();

		expect(urls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
	});

	it("lets Antigravity effort-tier model IDs control thinking", async () => {
		let payload:
			| {
					model?: unknown;
					request?: { generationConfig?: { thinkingConfig?: unknown } };
			  }
			| undefined;
		let userAgent: string | null = null;
		global.fetch = vi.fn(async (_input, init) => {
			payload = JSON.parse(String(init?.body));
			userAgent = new Headers(init?.headers).get("user-agent");
			return createSseResponse();
		}) as typeof fetch;

		const model: Model<"google-gemini-cli"> = {
			id: "gemini-3.8-flash-high",
			name: "Gemini 3.8 Flash (High)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		};
		const context: Context = {
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const stream = streamSimpleGoogleGeminiCli(model, context, {
			apiKey: JSON.stringify({
				token: "token",
				projectId: "project",
				userAgent: "antigravity/hub/2.12.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)",
			}),
			reasoning: "low",
		});
		for await (const _event of stream) {
			// exhaust stream
		}
		await stream.result();

		expect(payload?.model).toBe("gemini-3.8-flash-high");
		expect(payload?.request?.generationConfig?.thinkingConfig).toBeUndefined();
		expect(userAgent).toBe("antigravity/hub/2.12.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)");
	});
});

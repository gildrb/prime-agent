import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiCodexOAuthProvider, refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";
import type { OAuthAuthInfo, OAuthDeviceCodeInfo, OAuthSelectPrompt } from "../src/utils/oauth/types.js";

function createAccessToken(accountId: string): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("offers and completes the headless device-code flow", async () => {
		const accessToken = createAccessToken("account-123");
		const selectPrompts: OAuthSelectPrompt[] = [];
		const deviceInfos: OAuthDeviceCodeInfo[] = [];
		const progress: string[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const url = String(input);
				if (url.endsWith("/api/accounts/deviceauth/usercode")) {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({ device_auth_id: "device-id", user_code: "ABCD-1234", interval: 5 });
				}
				if (url.endsWith("/api/accounts/deviceauth/token")) {
					expect(JSON.parse(String(init?.body))).toEqual({
						device_auth_id: "device-id",
						user_code: "ABCD-1234",
					});
					return jsonResponse({ authorization_code: "oauth-code", code_verifier: "device-verifier" });
				}
				if (url.endsWith("/oauth/token")) {
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("code")).toBe("oauth-code");
					expect(params.get("code_verifier")).toBe("device-verifier");
					expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
					return jsonResponse({ access_token: accessToken, refresh_token: "refresh-token", expires_in: 3600 });
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(
			openaiCodexOAuthProvider.login({
				onAuth: () => {
					throw new Error("Browser login must not open");
				},
				onDeviceCode: (info) => deviceInfos.push(info),
				onPrompt: async () => {
					throw new Error("Manual prompt must not open");
				},
				onProgress: (message) => progress.push(message),
				onSelect: async (prompt) => {
					selectPrompts.push(prompt);
					return "device_code";
				},
			}),
		).resolves.toMatchObject({ access: accessToken, refresh: "refresh-token", accountId: "account-123" });

		expect(selectPrompts).toEqual([
			{
				message: "Select OpenAI Codex login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "device_code", label: "Device code login (headless)" },
				],
			},
		]);
		expect(deviceInfos).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(progress).toContain("Waiting for device authorization...");
	});

	it("keeps browser login as the default compatible flow", async () => {
		const accessToken = createAccessToken("account-browser");
		const authInfos: OAuthAuthInfo[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const url = String(input);
				if (!url.endsWith("/oauth/token")) throw new Error(`Unexpected fetch URL: ${url}`);
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("code")).toBe("browser-code");
				expect(params.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
				return jsonResponse({ access_token: accessToken, refresh_token: "refresh-token", expires_in: 3600 });
			}),
		);

		await expect(
			openaiCodexOAuthProvider.login({
				onAuth: (info) => authInfos.push(info),
				onPrompt: async () => "browser-code",
				onManualCodeInput: async () => "browser-code",
			}),
		).resolves.toMatchObject({ access: accessToken, accountId: "account-browser" });
		expect(authInfos[0]?.url).toContain("https://auth.openai.com/oauth/authorize?");
		expect(authInfos[0]?.instructions).toContain("Complete login");
	});

	it("directs users to browser login when device authorization is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		await expect(
			openaiCodexOAuthProvider.login({
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => "device_code",
			}),
		).rejects.toThrow("device code login is unavailable. Use browser login instead");
	});

	it("cancels device polling without waiting for the next interval", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		let pollCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url.endsWith("/api/accounts/deviceauth/usercode")) {
					return jsonResponse({ device_auth_id: "device-id", user_code: "ABCD-1234", interval: 60 });
				}
				if (url.endsWith("/api/accounts/deviceauth/token")) {
					pollCount += 1;
					return jsonResponse({ error: "deviceauth_authorization_pending" }, 403);
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const login = openaiCodexOAuthProvider.login({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => "device_code",
			signal: controller.signal,
		});
		for (let attempt = 0; attempt < 5 && pollCount === 0; attempt += 1) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollCount).toBe(1);
		controller.abort();
		await expect(login).rejects.toThrow("Login cancelled");
	});

	it("cancels when login method selection is cancelled", async () => {
		await expect(
			openaiCodexOAuthProvider.login({
				onAuth: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});
});

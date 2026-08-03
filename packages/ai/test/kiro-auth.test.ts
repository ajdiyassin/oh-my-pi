import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import {
	loginKiroBrowser,
	loginKiroDevice,
	refreshKiroToken,
	selectKiroProfile,
	validateKiroApiKey,
} from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const PROFILE_ONE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/one";
const PROFILE_TWO = "arn:aws:codewhisperer:us-east-1:123456789012:profile/two";

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function modelCatalog(): Record<string, unknown> {
	return {
		defaultModel: "model-one",
		models: [
			{
				modelId: "model-one",
				modelName: "Model One",
				supportedInputModalities: ["TEXT"],
				supportedOutputModalities: ["TEXT"],
				tokenLimits: { maxInputTokens: 1000, maxOutputTokens: 500 },
			},
		],
	};
}

function registeredClient(): Record<string, unknown> {
	return {
		clientId: "client-id",
		clientSecret: "client-secret",
		clientSecretExpiresAt: 4_000_000_000,
		authorizationEndpoint: "https://oidc.us-east-1.amazonaws.com/authorize",
		tokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
	};
}

describe("Kiro authentication", () => {
	it("normalizes and validates an API key against an explicit region", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return json(modelCatalog());
		};

		const result = await validateKiroApiKey("  'ksk_test-key/with+symbols' \n", {
			apiRegion: "us-east-1",
			fetch,
		});

		expect(result).toEqual({
			type: "api_key",
			key: "ksk_test-key/with+symbols",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://management.us-east-1.kiro.dev/");
		expect(new Headers(requests[0]?.init?.headers).get("x-amz-target")).toBe(
			"AmazonCodeWhispererService.ListAvailableModels",
		);
	});

	it("rejects malformed API keys before making a network request", async () => {
		let called = false;
		await expect(
			validateKiroApiKey("not-a-kiro-key", {
				apiRegion: "us-east-1",
				fetch: async () => {
					called = true;
					return json(modelCatalog());
				},
			}),
		).rejects.toMatchObject({ kind: "validation" });
		expect(called).toBe(false);
	});

	it("prompts for a selected profile without exposing its ARN or account id", async () => {
		let prompt = "";
		const selected = await selectKiroProfile("access-token", "us-east-1", {
			fetch: async () =>
				json({
					profiles: [
						{ arn: PROFILE_ONE, profileName: "Personal" },
						{ arn: PROFILE_TWO, profileName: "Work" },
					],
				}),
			onPrompt: async options => {
				prompt = options.message;
				return "2";
			},
		});

		expect(selected).toEqual({ profileArn: PROFILE_TWO, profileName: "Work" });
		expect(prompt).toContain("Personal");
		expect(prompt).toContain("Work");
		expect(prompt).not.toContain("arn:");
		expect(prompt).not.toContain("123456789012");
	});

	it("completes the Builder ID device flow and preserves client/profile state", async () => {
		const requests: string[] = [];
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const responses = [
			json(registeredClient()),
			json({
				deviceCode: "device-code",
				userCode: "ABCD-EFGH",
				verificationUriComplete: "https://device.sso.aws.dev/complete",
				expiresIn: 60,
				interval: 1,
			}),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			json({ profiles: [{ arn: PROFILE_TWO, profileName: "Work" }] }),
		];
		const fetch: FetchImpl = async input => {
			requests.push(String(input));
			return responses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const result = await loginKiroDevice(
			{
				onAuth: info => authEvents.push(info),
				onPrompt: async () => "",
				fetch,
			},
			{ region: "us-east-1", scopes: ["codewhisperer:completions"], pollIntervalMs: 1 },
		);

		expect(requests).toEqual([
			"https://oidc.us-east-1.amazonaws.com/client/register",
			"https://oidc.us-east-1.amazonaws.com/device_authorization",
			"https://oidc.us-east-1.amazonaws.com/token",
			"https://management.us-east-1.kiro.dev/",
		]);
		expect(authEvents).toEqual([
			{ url: "https://device.sso.aws.dev/complete", instructions: "Enter code ABCD-EFGH" },
		]);
		expect(result).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			kiroClientId: "client-id",
			kiroClientSecret: "client-secret",
			kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			kiroAuthMethod: "device",
			orgId: PROFILE_TWO,
			orgName: "Work",
		});
	});

	it("completes browser/manual Builder ID login with PKCE and profile selection", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const authUrls: string[] = [];
		const responses = [
			json(registeredClient()),
			json({ accessToken: "browser-access", refreshToken: "browser-refresh", expiresIn: 3600 }),
			json({ profiles: [{ arn: PROFILE_ONE, profileName: "Personal" }] }),
		];
		const fetch: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return responses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const result = await loginKiroBrowser(
			{
				onAuth: info => authUrls.push(info.url),
				onPrompt: async () => "",
				onManualCodeInput: async () => "authorization-code",
				fetch,
			},
			{
				issuerUrl: "https://view.awsapps.com/start",
				region: "us-east-1",
				preferredPort: 8765,
				scopes: ["codewhisperer:completions"],
				manualInputOnly: true,
			},
		);

		expect(authUrls).toHaveLength(1);
		const authorizationUrl = new URL(authUrls[0]!);
		expect(authorizationUrl.searchParams.get("client_id")).toBe("client-id");
		expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("http://localhost:8765/oauth/callback");
		expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(requests[1]?.url).toBe("https://oidc.us-east-1.amazonaws.com/token");
		const tokenBody = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;
		expect(tokenBody).toMatchObject({
			clientId: "client-id",
			clientSecret: "client-secret",
			code: "authorization-code",
			grantType: "authorization_code",
			redirectUri: "http://localhost:8765/oauth/callback",
		});
		expect(typeof tokenBody.codeVerifier).toBe("string");
		expect(result).toMatchObject({
			access: "browser-access",
			refresh: "browser-refresh",
			kiroAuthMethod: "browser",
			orgId: PROFILE_ONE,
			orgName: "Personal",
		});
	});

	it("refreshes with the registered client and keeps the selected profile", async () => {
		let request: RequestInit | undefined;
		const result = await refreshKiroToken(
			{
				access: "old-access",
				refresh: "refresh-token",
				expires: 0,
				kiroClientId: "client-id",
				kiroClientSecret: "client-secret",
				kiroClientSecretExpiresAt: Date.now() + 60_000,
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
				kiroAuthMethod: "device",
				orgId: PROFILE_TWO,
				orgName: "Work",
			},
			{
				fetch: async (_input, init) => {
					request = init;
					return json({ accessToken: "new-access", expiresIn: 3600 });
				},
			},
		);

		expect(JSON.parse(String(request?.body))).toEqual({
			grantType: "refresh_token",
			refreshToken: "refresh-token",
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		expect(result).toMatchObject({
			access: "new-access",
			refresh: "refresh-token",
			kiroClientId: "client-id",
			kiroAuthMethod: "device",
			orgId: PROFILE_TWO,
			orgName: "Work",
		});
	});

	it("rejects an expired registered client and cancellation before network access", async () => {
		let called = false;
		await expect(
			refreshKiroToken(
				{
					access: "access",
					refresh: "refresh",
					expires: 0,
					kiroClientId: "client-id",
					kiroClientSecret: "client-secret",
					kiroClientSecretExpiresAt: Date.now() - 1,
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
					kiroAuthMethod: "device",
				},
				{
					fetch: async () => {
						called = true;
						return json({ accessToken: "unexpected", expiresIn: 3600 });
					},
				},
			),
		).rejects.toMatchObject({ kind: "token-refresh" });
		expect(called).toBe(false);

		const controller = new AbortController();
		controller.abort();
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					signal: controller.signal,
					fetch: async () => json(registeredClient()),
				},
				{ region: "us-east-1", scopes: ["codewhisperer:completions"] },
			),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});

	it("fails closed on an oversized token response", async () => {
		await expect(
			refreshKiroToken(
				{
					access: "access",
					refresh: "refresh",
					expires: 0,
					kiroClientId: "client-id",
					kiroClientSecret: "client-secret",
					kiroClientSecretExpiresAt: Date.now() + 60_000,
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
					kiroAuthMethod: "device",
				},
				{
					fetch: async () => new Response(`{"accessToken":"${"x".repeat(140_000)}"}`, { status: 200 }),
				},
			),
		).rejects.toThrow("exceeded size limit");
	});
});

describe("Kiro OAuth API-key projection", () => {
	it("serializes the selected profile for the native runtime transport", async () => {
		const result = await getOAuthApiKey("kiro", {
			kiro: {
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				orgId: PROFILE_ONE,
			},
		});

		expect(result).not.toBeNull();
		expect(JSON.parse(result!.apiKey)).toEqual({ token: "access-token", profileArn: PROFILE_ONE });
	});
});

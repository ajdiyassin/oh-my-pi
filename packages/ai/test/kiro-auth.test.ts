import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { kiroProvider } from "@oh-my-pi/pi-ai/registry/kiro";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import {
	KIRO_IDENTITY_CENTER_SCOPES,
	loginKiroDevice,
	refreshKiroToken,
	selectKiroProfile,
	validateKiroApiKey,
} from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type { OAuthLoginCache, OAuthPrompt } from "@oh-my-pi/pi-ai/registry/oauth/types";
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

function registeredClient(region = "us-east-1"): Record<string, unknown> {
	return {
		clientId: "client-id",
		clientSecret: "client-secret",
		clientSecretExpiresAt: 4_000_000_000,
		tokenEndpoint: `https://oidc.${region}.amazonaws.com/token`,
	};
}

function deviceAuthorization(): Record<string, unknown> {
	return {
		deviceCode: "device-code",
		userCode: "ABCD-EFGH",
		verificationUri: "https://device.sso.aws.dev/verify",
		verificationUriComplete: "https://device.sso.aws.dev/complete",
		expiresIn: 60,
		interval: 1,
	};
}

function profileResponses(): Response[] {
	return [json({ profiles: [{ arn: PROFILE_TWO, profileName: "Work" }] }), json({ profiles: [] })];
}

function memoryCache(): { cache: OAuthLoginCache; values: Map<string, string> } {
	const values = new Map<string, string>();
	const expiry = new Map<string, number>();
	const cache: OAuthLoginCache = {
		get: (key, options) => {
			const value = values.get(key);
			if (value === undefined) return null;
			if (options?.includeExpired !== true && (expiry.get(key) ?? 0) <= Math.floor(Date.now() / 1000)) {
				return null;
			}
			return value;
		},
		set: (key, value, expiresAtSec) => {
			values.set(key, value);
			expiry.set(key, expiresAtSec);
		},
	};
	return { cache, values };
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

	it("shows only AWS, deferred Builder, and API choices", async () => {
		const prompts: OAuthPrompt[] = [];
		const progress: string[] = [];
		const result = await kiroProvider.login({
			onAuth: () => {},
			onProgress: message => progress.push(message),
			onPrompt: async prompt => {
				prompts.push(prompt);
				return "Builder";
			},
			fetch: async () => {
				throw new Error("Builder must not make a request");
			},
		});

		expect(result).toBe("");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toBe("Select login method\n❯ AWS\n  Builder\n  API");
		expect(prompts[0]?.defaultValue).toBe("AWS");
		expect(progress).toEqual(["Builder ID login is not available yet."]);
	});

	it("routes API selection to the existing API-key validation path", async () => {
		const prompts: string[] = [];
		let called = false;
		await expect(
			kiroProvider.login({
				onAuth: () => {},
				onPrompt: async prompt => {
					prompts.push(prompt.message);
					return prompts.length === 1 ? "API" : "not-a-key";
				},
				fetch: async () => {
					called = true;
					return json(modelCatalog());
				},
			}),
		).rejects.toMatchObject({ kind: "validation" });
		expect(prompts).toEqual(["Select login method\n❯ AWS\n  Builder\n  API", "Paste your Kiro API key"]);
		expect(called).toBe(false);
	});

	it("prompts for IAM Identity Center values, uses exact registration scopes, and reuses saved state", async () => {
		const { cache, values } = memoryCache();
		const prompts: OAuthPrompt[] = [];
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const progress: string[] = [];
		const firstRequests: Array<{ url: string; init?: RequestInit }> = [];
		const firstResponses: Response[] = [
			json(registeredClient("eu-west-1")),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		const firstFetch: FetchImpl = async (input, init) => {
			firstRequests.push({ url: String(input), init });
			return firstResponses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const first = await loginKiroDevice(
			{
				onAuth: info => authEvents.push(info),
				onProgress: message => progress.push(message),
				onPrompt: async prompt => {
					prompts.push(prompt);
					return prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "eu-west-1";
				},
				fetch: firstFetch,
				cache,
				sleep: async () => {},
			},
			{},
		);

		expect(prompts.map(prompt => prompt.message)).toEqual(["Enter Start URL", "Enter Region"]);
		const registrationBody = JSON.parse(String(firstRequests[0]?.init?.body)) as Record<string, unknown>;
		expect(registrationBody).toEqual({
			clientName: "Kiro CLI",
			clientType: "public",
			scopes: [...KIRO_IDENTITY_CENTER_SCOPES],
		});
		expect(Object.keys(registrationBody).sort()).toEqual(["clientName", "clientType", "scopes"]);
		expect(firstRequests[0]?.url).toBe("https://oidc.eu-west-1.amazonaws.com/client/register");
		const deviceBody = JSON.parse(String(firstRequests[1]?.init?.body)) as Record<string, unknown>;
		expect(deviceBody).toEqual({
			clientId: "client-id",
			clientSecret: "client-secret",
			startUrl: "https://example.awsapps.com/start",
		});
		expect(authEvents).toEqual([
			{
				url: "https://device.sso.aws.dev/complete",
				instructions:
					"Confirm the following code in the browser\nCode: ABCD-EFGH\nOpen this URL: https://device.sso.aws.dev/complete",
			},
		]);
		expect(progress).toEqual(["Logging in..."]);
		expect(first).toMatchObject({
			kiroAuthMethod: "device",
			kiroAccountType: "iam-identity-center",
			kiroOidcRegion: "eu-west-1",
			kiroRuntimeRegion: "us-east-1",
			kiroProfileArn: PROFILE_TWO,
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			orgId: PROFILE_TWO,
		});
		for (const value of values.values()) {
			expect(value).not.toContain("device-code");
			expect(value).not.toContain("ABCD-EFGH");
			expect(value).not.toContain("access-token");
			expect(value).not.toContain("refresh-token");
		}

		const secondPrompts: OAuthPrompt[] = [];
		const secondRequests: string[] = [];
		const secondResponses: Response[] = [
			json(deviceAuthorization()),
			json({ accessToken: "second-access", refreshToken: "second-refresh", expiresIn: 3600 }),
			...profileResponses(),
		];
		const secondFetch: FetchImpl = async input => {
			secondRequests.push(String(input));
			return secondResponses.shift() ?? json({ error: "unexpected request" }, 500);
		};
		await loginKiroDevice(
			{
				onAuth: () => {},
				onPrompt: async prompt => {
					secondPrompts.push(prompt);
					return "";
				},
				fetch: secondFetch,
				cache,
				sleep: async () => {},
			},
			{},
		);
		expect(secondPrompts.map(prompt => prompt.defaultValue)).toEqual([
			"https://example.awsapps.com/start",
			"eu-west-1",
		]);
		expect(secondRequests[0]).toBe("https://oidc.eu-west-1.amazonaws.com/device_authorization");
		expect(secondRequests).not.toContain("https://oidc.eu-west-1.amazonaws.com/client/register");
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

	it("refreshes with the registered client, rotates refresh tokens, and keeps profile provenance", async () => {
		let request: RequestInit | undefined;
		const result = await refreshKiroToken(
			{
				access: "old-access",
				refresh: "refresh-token",
				expires: 0,
				kiroClientId: "client-id",
				kiroClientSecret: "client-secret",
				kiroClientSecretExpiresAt: Date.now() + 60_000,
				kiroTokenEndpoint: "https://oidc.eu-west-1.amazonaws.com/token",
				kiroAuthMethod: "device",
				kiroOidcRegion: "eu-west-1",
				kiroProfileArn: PROFILE_TWO,
				kiroRuntimeRegion: "us-east-1",
				orgId: PROFILE_TWO,
				orgName: "Work",
			},
			{
				fetch: async (_input, init) => {
					request = init;
					return json({ accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 3600 });
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
			refresh: "rotated-refresh",
			kiroClientId: "client-id",
			kiroAuthMethod: "device",
			kiroOidcRegion: "eu-west-1",
			kiroProfileArn: PROFILE_TWO,
			kiroRuntimeRegion: "us-east-1",
			orgId: PROFILE_TWO,
		});
	});

	it("retains the old refresh token when rotation is omitted and rejects expired clients/cancellation", async () => {
		const retained = await refreshKiroToken(
			{
				access: "old-access",
				refresh: "refresh-token",
				expires: 0,
				kiroClientId: "client-id",
				kiroClientSecret: "client-secret",
				kiroClientSecretExpiresAt: Date.now() + 60_000,
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
				kiroAuthMethod: "device",
			},
			{
				fetch: async () => json({ accessToken: "new-access", expiresIn: 3600 }),
			},
		);
		expect(retained.refresh).toBe("refresh-token");

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
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
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

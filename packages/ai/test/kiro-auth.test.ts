import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { kiroProvider } from "@oh-my-pi/pi-ai/registry/kiro";
import {
	loginKiroBrowser,
	loginKiroDevice,
	refreshKiroToken,
	selectKiroProfile,
	validateKiroApiKey,
} from "@oh-my-pi/pi-ai/registry/oauth/kiro";

const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/example";

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function modelCatalog() {
	return {
		defaultModel: "auto",
		models: [
			{
				modelId: "auto",
				modelName: "Auto",
				supportedInputModalities: ["TEXT"],
				supportedOutputModalities: ["TEXT"],
				tokenLimits: { maxInputTokens: 200_000, maxOutputTokens: 32_000 },
			},
		],
	};
}

describe("isolated Kiro authentication", () => {
	it("validates an API key only when exactly one bootstrap route succeeds", async () => {
		const fetch = async (input: string | URL | Request) =>
			String(input).includes("us-east-1") ? json(modelCatalog()) : json({ error: "invalid_request" }, 400);
		expect(await validateKiroApiKey(" 'ksk_test' ", { fetch })).toEqual({
			type: "api_key",
			key: "ksk_test",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
		});
		await expect(validateKiroApiKey("not-a-kiro-key", { fetch })).rejects.toMatchObject({ kind: "validation" });
		await expect(validateKiroApiKey("ksk_test", { fetch: async () => json({}, 400) })).rejects.toMatchObject({
			kind: "discovery",
		});
		await expect(validateKiroApiKey("ksk_test", { fetch: async () => json(modelCatalog()) })).rejects.toMatchObject({
			kind: "discovery",
		});
	});

	it("bounds API responses and preserves explicit-region cancellation", async () => {
		const oversized = "x".repeat(128 * 1024 + 1);
		await expect(
			refreshKiroToken(
				{
					access: "old",
					refresh: "refresh",
					expires: 0,
					kiroClientId: "client",
					kiroTokenEndpoint: "https://auth.us-east-1.kiro.dev/oauth/token",
					kiroAuthMethod: "browser",
				},
				{ fetch: async () => new Response(oversized) },
			),
		).rejects.toThrow("exceeded size limit");
		await expect(
			refreshKiroToken(
				{
					access: "old",
					refresh: "refresh",
					expires: 0,
					kiroClientId: "client",
					kiroTokenEndpoint: "https://auth.us-east-1.kiro.dev/oauth/token",
					kiroAuthMethod: "browser",
				},
				{
					fetch: async () => new Response(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])),
				},
			),
		).rejects.toThrow("invalid JSON");
		await expect(
			refreshKiroToken(
				{
					access: "old",
					refresh: "refresh",
					expires: 0,
					kiroClientId: "client",
					kiroTokenEndpoint: "https://auth.us-east-1.kiro.dev/oauth/token",
					kiroAuthMethod: "browser",
				},
				{ fetch: async () => new Response("") },
			),
		).rejects.toThrow("invalid JSON");

		const controller = new AbortController();
		await expect(
			validateKiroApiKey("ksk_test", {
				apiRegion: "us-east-1",
				signal: controller.signal,
				fetch: async () => {
					controller.abort();
					throw new DOMException("cancelled", "AbortError");
				},
			}),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});

	it("selects zero, one, and multiple profiles without persisting before return", async () => {
		await expect(
			selectKiroProfile("token", "us-east-1", { fetch: async () => json({ profiles: [] }) }),
		).rejects.toBeInstanceOf(AIError.OAuthError);
		expect(
			await selectKiroProfile("token", "us-east-1", {
				fetch: async () => json({ profiles: [{ arn: profileArn, profileName: "Example" }] }),
			}),
		).toEqual({ profileArn, profileName: "Example" });
		let profilePrompt = "";
		expect(
			await selectKiroProfile("token", "us-east-1", {
				fetch: async () =>
					json({
						profiles: [
							{ arn: profileArn, profileName: "Primary" },
							{ arn: profileArn.replace("example", "other") },
						],
					}),
				onPrompt: async prompt => {
					profilePrompt = prompt.message;
					return "2";
				},
			}),
		).toEqual({ profileArn: profileArn.replace("example", "other"), profileName: undefined });
		expect(profilePrompt).toBe("Select a Kiro profile:\n1. Primary\n2. profile in us-east-1");
		expect(profilePrompt).not.toContain("111122223333");
		await expect(
			selectKiroProfile("token", "us-east-1", { fetch: async () => json({ profiles: [{ arn: "invalid" }] }) }),
		).rejects.toBeInstanceOf(AIError.OAuthError);
	});

	it("completes browser PKCE manually, selects a profile, and rejects HTTP failure or cancellation", async () => {
		const requests: Array<{ url: string; body: string }> = [];
		const callbacks = {
			onAuth: () => {},
			onPrompt: async () => "",
			onManualCodeInput: async () => "code",
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), body: String(init?.body ?? "") });
				return String(input).includes("management")
					? json({ profiles: [{ arn: profileArn, profileName: "Example" }] })
					: json({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 });
			},
		};
		const config = {
			region: "us-east-1",
			clientId: "client",
			preferredPort: 0,
			scopes: ["scope"],
			manualInputOnly: true,
		};
		const loggedIn = await loginKiroBrowser(callbacks, config);
		expect(loggedIn).toMatchObject({
			access: "access",
			orgId: profileArn,
			orgName: "Example",
			kiroClientId: "client",
			kiroAuthMethod: "browser",
			kiroTokenEndpoint: "https://auth.us-east-1.kiro.dev/oauth/token",
		});
		const exchange = new URLSearchParams(requests[0]!.body);
		expect(exchange.get("grant_type")).toBe("authorization_code");
		expect(exchange.get("code_verifier")).toBeTruthy();
		expect(requests[1]).toMatchObject({ url: "https://management.us-east-1.kiro.dev/" });
		await expect(
			loginKiroBrowser({ ...callbacks, fetch: async () => json({ error: "denied" }, 400) }, config),
		).rejects.toMatchObject({ kind: "token-exchange" });
		const cancelled = new AbortController();
		cancelled.abort("cancelled");
		await expect(loginKiroBrowser({ ...callbacks, signal: cancelled.signal }, config)).rejects.toBeInstanceOf(
			AIError.LoginCancelledError,
		);
	});

	it("matches the captured Builder ID device request bodies", async () => {
		const requests: Array<{ url: string; contentType: string | null; body: unknown }> = [];
		const responses = [
			json({
				clientId: "client",
				clientSecret: "secret",
				tokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
				clientSecretExpiresAt: 4_000_000_000,
			}),
			json({
				deviceCode: "device",
				userCode: "user",
				verificationUri: "https://example.test",
				expiresIn: 60,
				interval: 1,
			}),
			json({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 }),
			json({ profiles: [{ arn: profileArn, profileName: "Example" }] }),
		];
		const loggedIn = await loginKiroDevice(
			{
				onAuth: () => {},
				onPrompt: async () => "",
				fetch: async (input, init) => {
					const contentType = new Headers(init?.headers).get("content-type");
					requests.push({ url: String(input), contentType, body: JSON.parse(String(init?.body)) as unknown });
					return responses.shift()!;
				},
			},
			{ kind: "builder-id", region: "us-east-1", scopes: ["scope"], pollIntervalMs: 1 },
		);

		expect(requests.slice(0, 3)).toEqual([
			{
				url: "https://oidc.us-east-1.amazonaws.com/client/register",
				contentType: "application/json",
				body: { clientName: "oh-my-pi", clientType: "public", scopes: ["scope"] },
			},
			{
				url: "https://oidc.us-east-1.amazonaws.com/device_authorization",
				contentType: "application/json",
				body: { clientId: "client", clientSecret: "secret", startUrl: "https://view.awsapps.com/start" },
			},
			{
				url: "https://oidc.us-east-1.amazonaws.com/token",
				contentType: "application/json",
				body: {
					grantType: "urn:ietf:params:oauth:grant-type:device_code",
					deviceCode: "device",
					clientId: "client",
					clientSecret: "secret",
				},
			},
		]);
		expect(loggedIn).toMatchObject({
			orgId: profileArn,
			kiroAuthMethod: "builder-id",
			kiroClientSecretExpiresAt: 4_000_000_000_000,
		});
	});

	it("completes, rejects, cancels, and bounds desktop device polling", async () => {
		const responses = [
			json({
				deviceCode: "device",
				userCode: "user",
				verificationUri: "https://example.test",
				expiresInMilliseconds: 1000,
				intervalInMilliseconds: 1,
			}),
			json({ status: "authorized", accessToken: "access", refreshToken: "refresh", expiresIn: 3600, profileArn }),
		];
		const callbacks = { onAuth: () => {}, onPrompt: async () => "", fetch: async () => responses.shift()! };
		expect(
			(await loginKiroDevice(callbacks, { kind: "google", region: "us-east-1", appId: "app", pollIntervalMs: 1 }))
				.orgId,
		).toBe(profileArn);
		const denied = [
			json({
				deviceCode: "device",
				userCode: "user",
				verificationUri: "https://example.test",
				expiresInMilliseconds: 1000,
				intervalInMilliseconds: 1,
			}),
			json({ status: "denied" }, 400),
		];
		await expect(
			loginKiroDevice(
				{ ...callbacks, fetch: async () => denied.shift()! },
				{ kind: "github", region: "us-east-1", appId: "app", pollIntervalMs: 1 },
			),
		).rejects.toMatchObject({ kind: "device-auth" });
		const controller = new AbortController();
		controller.abort();
		await expect(
			loginKiroDevice(
				{ ...callbacks, signal: controller.signal },
				{ kind: "google", region: "us-east-1", appId: "app" },
			),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
		const pending = [
			json({
				deviceCode: "device",
				userCode: "user",
				verificationUri: "https://example.test",
				expiresInMilliseconds: 1000,
				intervalInMilliseconds: 1,
			}),
			json({ status: "authorization_pending" }, 429),
		];
		await expect(
			loginKiroDevice(
				{ ...callbacks, fetch: async () => pending.shift()! },
				{ kind: "google", region: "us-east-1", appId: "app", maxPolls: 1, pollIntervalMs: 1 },
			),
		).rejects.toMatchObject({ kind: "timeout" });
	});

	it("uses each refresh protocol and preserves selected profile state", async () => {
		const cases = [
			{
				credential: {
					kiroClientId: "client",
					kiroClientSecret: "secret",
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
					kiroClientSecretExpiresAt: 4_000_000_000_000,
					kiroAuthMethod: "builder-id" as const,
				},
				contentType: "application/json",
				body: JSON.stringify({
					grantType: "refresh_token",
					refreshToken: "refresh",
					clientId: "client",
					clientSecret: "secret",
				}),
			},
			{
				credential: {
					kiroClientId: "app",
					kiroTokenEndpoint: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
					kiroAuthMethod: "google" as const,
				},
				contentType: "application/json",
				body: JSON.stringify({ refreshToken: "refresh" }),
			},
			{
				credential: {
					kiroClientId: "client",
					kiroTokenEndpoint: "https://auth.us-east-1.kiro.dev/oauth/token",
					kiroAuthMethod: "browser" as const,
				},
				contentType: "application/x-www-form-urlencoded",
				body: "grant_type=refresh_token&refresh_token=refresh&client_id=client",
			},
		] as const;
		for (const testCase of cases) {
			let request: RequestInit | undefined;
			const refreshed = await refreshKiroToken(
				{
					refresh: "refresh",
					access: "old",
					expires: 0,
					...testCase.credential,
					orgId: profileArn,
					orgName: "Example",
				},
				{
					fetch: async (_input, init) => {
						request = init;
						return json({ accessToken: "new", expiresIn: 3600 });
					},
				},
			);
			expect(new Headers(request?.headers).get("content-type")).toBe(testCase.contentType);
			expect(String(request?.body)).toBe(testCase.body);
			expect(refreshed).toMatchObject({
				access: "new",
				refresh: "refresh",
				orgId: profileArn,
				orgName: "Example",
				kiroAuthMethod: testCase.credential.kiroAuthMethod,
			});
			if (testCase.credential.kiroAuthMethod === "builder-id") {
				expect(refreshed.kiroClientSecretExpiresAt).toBe(4_000_000_000_000);
			}
		}
	});

	it("rejects refresh after the Builder ID registered client expires", async () => {
		let requested = false;
		await expect(
			refreshKiroToken(
				{
					refresh: "refresh",
					access: "old",
					expires: 0,
					kiroClientId: "client",
					kiroClientSecret: "secret",
					kiroClientSecretExpiresAt: Date.now() - 1,
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
					kiroAuthMethod: "builder-id",
				},
				{
					fetch: async () => {
						requested = true;
						return json({ accessToken: "unexpected", expiresIn: 3600 });
					},
				},
			),
		).rejects.toMatchObject({ kind: "token-refresh" });
		expect(requested).toBe(false);
	});

	it("exports a complete but unregistered provider leaf", () => {
		expect(kiroProvider).toMatchObject({
			id: "kiro",
			envKeys: "KIRO_API_KEY",
			credentialPolicy: "replace",
			showInLoginList: false,
		});
		expect(kiroProvider.getApiKey?.({ refresh: "r", access: "a", expires: 1, orgId: profileArn })).toBe(
			JSON.stringify({ token: "a", profileArn }),
		);
		expect(() => kiroProvider.getApiKey?.({ refresh: "r", access: "a", expires: 1 })).toThrow(
			"missing the selected profile",
		);
		expect(getProviderDefinition("kiro")).toBeUndefined();
	});
});

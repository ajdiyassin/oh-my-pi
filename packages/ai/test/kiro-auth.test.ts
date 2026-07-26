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
					kiroClientSecret: "secret",
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
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
					kiroClientSecret: "secret",
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
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
					kiroClientSecret: "secret",
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
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

	it("registers the actual loopback redirect before browser PKCE token exchange", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		let callbackUri = "";
		const callbacks = {
			onAuth: ({ url }: { url: string }) => {
				const authorization = new URL(url);
				callbackUri = authorization.searchParams.get("redirect_uri") ?? "";
				const callback = new URL(callbackUri);
				callback.searchParams.set("code", "code");
				callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
				void fetch(callback);
			},
			onPrompt: async () => "",
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requests.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
				if (url.endsWith("/client/register")) {
					return json({
						clientId: "client",
						clientSecret: "secret",
						clientSecretExpiresAt: 4_000_000_000,
						authorizationEndpoint: "https://oidc.us-east-1.amazonaws.com/authorize",
						tokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
					});
				}
				if (url.endsWith("/token"))
					return json({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 });
				return json({ profiles: [{ arn: profileArn, profileName: "Example" }] });
			},
		};
		const config = {
			issuerUrl: "https://view.awsapps.com/start",
			region: "us-east-1",
			preferredPort: 0,
			scopes: ["scope"],
		};
		const loggedIn = await loginKiroBrowser(callbacks, config);
		expect(loggedIn).toMatchObject({
			access: "access",
			orgId: profileArn,
			orgName: "Example",
			kiroClientId: "client",
			kiroClientSecret: "secret",
			kiroAuthMethod: "browser",
			kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
		});
		expect(requests[0]).toEqual({
			url: "https://oidc.us-east-1.amazonaws.com/client/register",
			body: {
				clientName: "oh-my-pi",
				clientType: "public",
				scopes: ["scope"],
				grantTypes: ["authorization_code", "refresh_token"],
				issuerUrl: "https://view.awsapps.com/start",
				redirectUris: [callbackUri],
			},
		});
		expect(callbackUri).toMatch(/^http:\/\/localhost:\d+\/oauth\/callback$/);
		expect(requests[1]?.body).toMatchObject({
			clientId: "client",
			clientSecret: "secret",
			code: "code",
			grantType: "authorization_code",
			redirectUri: callbackUri,
		});
		expect(requests[1]?.body.codeVerifier).toBeTruthy();
		expect(requests[2]?.url).toBe("https://management.us-east-1.kiro.dev/");
		const cancelled = new AbortController();
		cancelled.abort("cancelled");
		await expect(loginKiroBrowser({ ...callbacks, signal: cancelled.signal }, config)).rejects.toBeInstanceOf(
			AIError.LoginCancelledError,
		);
	});

	it("matches the captured AWS OIDC device request bodies", async () => {
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
					requests.push({
						url: String(input),
						contentType: new Headers(init?.headers).get("content-type"),
						body: JSON.parse(String(init?.body)) as unknown,
					});
					return responses.shift()!;
				},
			},
			{ region: "us-east-1", scopes: ["scope"], pollIntervalMs: 1 },
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
			kiroAuthMethod: "device",
			kiroClientSecretExpiresAt: 4_000_000_000_000,
		});
	});

	it("rejects, cancels, and bounds AWS OIDC device polling", async () => {
		const registration = () =>
			json({
				clientId: "client",
				clientSecret: "secret",
				tokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			});
		const authorization = () =>
			json({
				deviceCode: "device",
				userCode: "user",
				verificationUri: "https://example.test",
				expiresIn: 60,
				interval: 1,
			});
		const denied = [registration(), authorization(), json({ error: "access_denied" }, 400)];
		await expect(
			loginKiroDevice(
				{ onAuth: () => {}, onPrompt: async () => "", fetch: async () => denied.shift()! },
				{ region: "us-east-1", maxPolls: 1, pollIntervalMs: 1 },
			),
		).rejects.toMatchObject({ kind: "device-auth" });
		const controller = new AbortController();
		controller.abort();
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					fetch: async () => registration(),
					signal: controller.signal,
				},
				{ region: "us-east-1" },
			),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
		const pending = [registration(), authorization(), json({ error: "authorization_pending" }, 400)];
		await expect(
			loginKiroDevice(
				{ onAuth: () => {}, onPrompt: async () => "", fetch: async () => pending.shift()! },
				{ region: "us-east-1", maxPolls: 1, pollIntervalMs: 1 },
			),
		).rejects.toMatchObject({ kind: "timeout" });
	});

	it("uses the registered-client refresh protocol and preserves selected profile state", async () => {
		for (const method of ["device", "browser"] as const) {
			let request: RequestInit | undefined;
			const refreshed = await refreshKiroToken(
				{
					refresh: "refresh",
					access: "old",
					expires: 0,
					kiroClientId: "client",
					kiroClientSecret: "secret",
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
					kiroClientSecretExpiresAt: 4_000_000_000_000,
					kiroAuthMethod: method,
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
			expect(new Headers(request?.headers).get("content-type")).toBe("application/json");
			expect(String(request?.body)).toBe(
				JSON.stringify({
					grantType: "refresh_token",
					refreshToken: "refresh",
					clientId: "client",
					clientSecret: "secret",
				}),
			);
			expect(refreshed).toMatchObject({
				access: "new",
				refresh: "refresh",
				orgId: profileArn,
				orgName: "Example",
				kiroAuthMethod: method,
				kiroClientSecretExpiresAt: 4_000_000_000_000,
			});
		}
	});

	it("rejects refresh after the registered client expires", async () => {
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
					kiroAuthMethod: "device",
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

	it("registers the native provider and preserves selected OAuth profile encoding", () => {
		expect(kiroProvider).toMatchObject({
			id: "kiro",
			envKeys: "KIRO_API_KEY",
			credentialPolicy: "replace",
		});
		expect(getProviderDefinition("kiro")).toBe(kiroProvider);
		expect(kiroProvider.getApiKey?.({ refresh: "r", access: "a", expires: 1, orgId: profileArn })).toBe(
			JSON.stringify({ token: "a", profileArn }),
		);
		expect(() => kiroProvider.getApiKey?.({ refresh: "r", access: "a", expires: 1 })).toThrow(
			"missing the selected profile",
		);
	});
});

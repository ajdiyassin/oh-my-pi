import { describe, expect, it, spyOn } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import {
	KIRO_AUTH_MAX_ATTEMPTS,
	KIRO_IDENTITY_CENTER_SCOPES,
	loginKiroDevice,
	loginKiroHook,
	refreshKiroHook,
	refreshKiroToken,
	selectKiroProfile,
	validateKiroApiKey,
} from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type {
	OAuthAuthInfo,
	OAuthController,
	OAuthCredentials,
	OAuthPrompt,
} from "@oh-my-pi/pi-ai/registry/oauth/types";
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
				supportedInputTypes: ["TEXT"],
				tokenLimits: { maxInputTokens: 1000, maxOutputTokens: 500 },
			},
		],
	};
}

function registeredClient(
	region = "us-east-1",
	tokenEndpoint: unknown = `https://oidc.${region}.amazonaws.com/token`,
	includeTokenEndpoint = true,
): Record<string, unknown> {
	return {
		clientId: "client-id",
		clientSecret: "client-secret",
		clientSecretExpiresAt: 4_000_000_000,
		...(includeTokenEndpoint ? { tokenEndpoint } : {}),
	};
}

function deviceAuthorization(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		deviceCode: "device-code",
		userCode: "ABCD-EFGH",
		verificationUri: "https://device.sso.aws.dev/verify",
		verificationUriComplete: "https://device.sso.aws.dev/complete",
		expiresIn: 60,
		interval: 1,
		...overrides,
	};
}

function profileResponses(): Response[] {
	return [json({ profiles: [{ arn: PROFILE_TWO, profileName: "Work" }] }), json({ profiles: [] })];
}

function kiroClientCredentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
	return {
		access: "old-access",
		refresh: "refresh-token",
		expires: 0,
		kiroClientId: "client-id",
		kiroClientSecret: "client-secret",
		kiroClientSecretExpiresAt: Date.now() + 60_000,
		kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
		...overrides,
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

	it("rejects an invalid KIRO_API_REGION pin before making a network request", async () => {
		let called = false;
		await expect(
			validateKiroApiKey("ksk_valid-key", {
				apiRegion: "not-a-region",
				fetch: async () => {
					called = true;
					return json(modelCatalog());
				},
			}),
		).rejects.toMatchObject({ kind: "configuration" });
		expect(called).toBe(false);
	});

	it("resolves an API-key route via bootstrap probe when no region is pinned", async () => {
		const requests: string[] = [];
		const fetch: FetchImpl = async input => {
			const url = String(input);
			requests.push(url);
			if (url === "https://management.us-east-1.kiro.dev/") return json(modelCatalog());
			return json({ error: "no such key" }, 500);
		};

		const result = await validateKiroApiKey("ksk_probe-key", { fetch });

		expect(result).toEqual({
			type: "api_key",
			key: "ksk_probe-key",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
		});
		expect(requests).toContain("https://management.us-east-1.kiro.dev/");
		expect(requests).toContain("https://management.eu-central-1.kiro.dev/");
	});

	it("returns the Builder stub without a network request for numbered choice 2", async () => {
		const prompts: OAuthPrompt[] = [];
		const progress: string[] = [];
		const result = await loginKiroHook({
			onAuth: () => {},
			onProgress: (message: string) => progress.push(message),
			onPrompt: async (prompt: OAuthPrompt) => {
				prompts.push(prompt);
				return "2";
			},
			fetch: async () => {
				throw new Error("Builder must not make a request");
			},
		});

		expect(result).toBe("");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toBe("Select Kiro login method\n1. AWS\n2. Builder\n3. API");
		expect(prompts[0]?.placeholder).toBe("1");
		expect(progress).toEqual(["Builder ID login is not available yet."]);
	});

	it("does not silently choose AWS when the login-method answer is empty", async () => {
		await expect(
			loginKiroHook({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);
	});

	it("routes API selection to the existing API-key validation path", async () => {
		const prompts: string[] = [];
		let called = false;
		let calls = 0;
		await expect(
			loginKiroHook({
				onAuth: () => {},
				onPrompt: async (prompt: OAuthPrompt) => {
					prompts.push(prompt.message);
					calls += 1;
					return calls === 1 ? "3" : "not-a-key";
				},
				fetch: async () => {
					called = true;
					return json(modelCatalog());
				},
			}),
		).rejects.toMatchObject({ kind: "validation" });
		expect(prompts[0]).toContain("Select Kiro login method");
		expect(prompts).toContain("Paste your Kiro API key");
		expect(called).toBe(false);
	});

	it("rejects an invalid Start URL before registering a client", async () => {
		let called = false;
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					fetch: async () => {
						called = true;
						return json(registeredClient());
					},
				},
				{ region: "us-east-1", startUrl: "https://example.com/not-start" },
			),
		).rejects.toMatchObject({ kind: "validation" });
		expect(called).toBe(false);
	});

	it("rejects an invalid Identity Center region before registering a client", async () => {
		let called = false;
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					fetch: async () => {
						called = true;
						return json(registeredClient());
					},
				},
				{ region: "not-a-region", startUrl: "https://example.awsapps.com/start" },
			),
		).rejects.toMatchObject({ kind: "validation" });
		expect(called).toBe(false);
	});

	it("prompts for IAM Identity Center values and uses exact registration scopes", async () => {
		const prompts: OAuthPrompt[] = [];
		const authEvents: OAuthAuthInfo[] = [];
		const progress: string[] = [];
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const responses: Response[] = [
			json(registeredClient("eu-west-1")),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		const fetch: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return responses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const loggedIn = await loginKiroDevice(
			{
				onAuth: (info: OAuthAuthInfo) => authEvents.push(info),
				onProgress: (message: string) => progress.push(message),
				onPrompt: async (prompt: OAuthPrompt) => {
					prompts.push(prompt);
					return prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "eu-west-1";
				},
				fetch,
			},
			{},
		);

		expect(prompts.map(prompt => prompt.message)).toEqual(["Enter Start URL", "Enter Region"]);
		const registrationBody = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
		expect(registrationBody).toEqual({
			clientName: "Kiro CLI",
			clientType: "public",
			scopes: [...KIRO_IDENTITY_CENTER_SCOPES],
		});
		expect(Object.keys(registrationBody).sort()).toEqual(["clientName", "clientType", "scopes"]);
		expect(requests[0]?.url).toBe("https://oidc.eu-west-1.amazonaws.com/client/register");
		const deviceBody = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;
		expect(deviceBody).toEqual({
			clientId: "client-id",
			clientSecret: "client-secret",
			startUrl: "https://example.awsapps.com/start",
		});
		expect(authEvents).toHaveLength(1);
		expect(authEvents[0]).toMatchObject({
			url: "https://device.sso.aws.dev/complete",
			instructions: "Confirm code ABCD-EFGH in the browser",
		});
		expect(progress).toEqual(["Waiting for device authorization..."]);
		expect(loggedIn).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			kiroClientId: "client-id",
			kiroClientSecret: "client-secret",
			kiroTokenEndpoint: "https://oidc.eu-west-1.amazonaws.com/token",
			kiroOidcRegion: "eu-west-1",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			orgId: PROFILE_TWO,
			orgName: "Work",
		});
		expect(loggedIn.expires).toBeGreaterThan(Date.now());
	});

	it("registers fresh on every login instead of reusing cached state", async () => {
		// The declarative registry has no OAuthLoginCache: each device login
		// performs a fresh OIDC client registration. Two consecutive logins
		// must both hit /client/register.
		const runLogin = async (): Promise<OAuthCredentials> => {
			const responses: Response[] = [
				json(registeredClient()),
				json(deviceAuthorization()),
				json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
				...profileResponses(),
			];
			const requests: string[] = [];
			const fetch: FetchImpl = async input => {
				requests.push(String(input));
				return responses.shift() ?? json({ error: "unexpected request" }, 500);
			};
			const loggedIn = await loginKiroDevice(
				{
					onAuth: () => {},
					fetch,
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			);
			expect(requests).toContain("https://oidc.us-east-1.amazonaws.com/client/register");
			return loggedIn;
		};

		const first = await runLogin();
		const second = await runLogin();
		expect(first.kiroClientId).toBe("client-id");
		expect(second.kiroClientId).toBe("client-id");
	});

	it("uses the canonical regional token endpoint when fresh registration omits it", async () => {
		const canonical = "https://oidc.eu-west-1.amazonaws.com/token";
		const requests: string[] = [];
		const responses: Response[] = [
			json(registeredClient("eu-west-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		const fetch: FetchImpl = async input => {
			requests.push(String(input));
			return responses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const loggedIn = await loginKiroDevice(
			{
				onAuth: () => {},
				fetch,
			},
			{ region: "eu-west-1", startUrl: "https://example.awsapps.com/start" },
		);

		expect(loggedIn.kiroTokenEndpoint).toBe(canonical);
		expect(requests.filter(url => url === canonical)).toHaveLength(1);

		let refreshUrl = "";
		const refreshed = await refreshKiroToken(
			{ ...loggedIn, expires: 0 },
			{
				fetch: async input => {
					refreshUrl = String(input);
					return json({ accessToken: "refreshed-access", expiresIn: 3600 });
				},
			},
		);
		expect(refreshUrl).toBe(canonical);
		expect(refreshed.kiroTokenEndpoint).toBe(canonical);
	});

	it("uses the canonical regional token endpoint when fresh registration returns null", async () => {
		const canonical = "https://oidc.eu-west-1.amazonaws.com/token";
		const requests: string[] = [];
		const responses: Response[] = [
			json(registeredClient("eu-west-1", null)),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		const fetch: FetchImpl = async input => {
			requests.push(String(input));
			return responses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const loggedIn = await loginKiroDevice(
			{
				onAuth: () => {},
				fetch,
			},
			{ region: "eu-west-1", startUrl: "https://example.awsapps.com/start" },
		);

		expect(loggedIn.kiroTokenEndpoint).toBe(canonical);
		expect(requests.filter(url => url === canonical)).toHaveLength(1);
	});

	// NOTE: cached-registration repair cases (omitted/null/invalid tokenEndpoint
	// in OAuthLoginCache, 59s/61s expiry margin) have no equivalent: the new
	// hook API performs a fresh registration per login and validates the
	// endpoint at registration time. Fresh-registration canonical cases above
	// and the invalid-endpoint rejection below cover the remaining contract.

	it("rejects present invalid registration endpoints instead of treating them as omitted", async () => {
		const invalidEndpoints: unknown[] = [
			"",
			"not-a-url",
			"https://oidc.us-west-2.amazonaws.com/token",
			"https://example.com/token",
			"https://oidc.us-east-1.amazonaws.com/authorize",
			"https://oidc.us-east-1.amazonaws.com:443/token",
			"https://user:pass@oidc.us-east-1.amazonaws.com/token",
			"https://oidc.us-east-1.amazonaws.com/token?query=1",
			"https://oidc.us-east-1.amazonaws.com/token#fragment",
		];

		for (const tokenEndpoint of invalidEndpoints) {
			await expect(
				loginKiroDevice(
					{
						onAuth: () => {},
						fetch: async input => {
							if (String(input).endsWith("/client/register")) {
								return json(registeredClient("us-east-1", tokenEndpoint));
							}
							return json({}, 500);
						},
					},
					{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
				),
			).rejects.toMatchObject({ kind: "validation" });
		}
	});

	it("persists the resolved endpoint in the stored OAuth credential", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store);
		const responses: Response[] = [
			json(registeredClient("us-east-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		try {
			const identity = await authStorage.login("kiro", {
				onAuth: () => {},
				onPrompt: async (prompt: OAuthPrompt) => {
					if (prompt.message.includes("Select Kiro login method")) return "1";
					return prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "us-east-1";
				},
				fetch: async () => responses.shift() ?? json({}, 500),
			});

			expect(identity?.type).toBe("oauth");
			expect(identity?.orgId).toBe(PROFILE_TWO);
			const stored = store.listAuthCredentials("kiro");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential).toMatchObject({
				type: "oauth",
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
				kiroClientId: "client-id",
				orgId: PROFILE_TWO,
			});
		} finally {
			authStorage.close();
		}
	});

	it("limits registration, device authorization, and polling transport retries to three attempts", async () => {
		expect(KIRO_AUTH_MAX_ATTEMPTS).toBe(3);
		const run = async (failureTarget: "registration" | "device" | "poll"): Promise<void> => {
			const counts = { registration: 0, device: 0, poll: 0 };
			const profiles = profileResponses();
			const ctrl: OAuthController = {
				onAuth: () => {},
				fetch: async input => {
					const url = String(input);
					if (url.endsWith("/client/register")) {
						counts.registration += 1;
						if (failureTarget === "registration" && counts.registration < 3) return json({}, 503);
						return json(registeredClient());
					}
					if (url.endsWith("/device_authorization")) {
						counts.device += 1;
						if (failureTarget === "device" && counts.device < 3) return json({}, 503);
						return json(deviceAuthorization());
					}
					if (url.endsWith("/token")) {
						counts.poll += 1;
						if (failureTarget === "poll" && counts.poll < 3) throw new Error("temporary network failure");
						return json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 });
					}
					return profiles.shift() ?? json({ profiles: [] });
				},
			};
			await loginKiroDevice(ctrl, { region: "us-east-1", startUrl: "https://example.awsapps.com/start" });
			expect(counts[failureTarget]).toBe(3);
		};

		await run("registration");
		await run("device");
		await run("poll");
	});

	it("continues polling after RFC 8628 pending and slow_down responses", async () => {
		const sleepSpy = spyOn(Bun, "sleep").mockImplementation((() => Promise.resolve()) as typeof Bun.sleep);
		try {
			const responses: Response[] = [
				json(registeredClient()),
				json(deviceAuthorization()),
				json({ error: "authorization_pending" }, 400),
				json({ error: "slow_down" }, 400),
				json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
				...profileResponses(),
			];
			const requests: string[] = [];
			const result = await loginKiroDevice(
				{
					onAuth: () => {},
					fetch: async input => {
						requests.push(String(input));
						return responses.shift() ?? json({ error: "unexpected request" }, 500);
					},
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			);

			expect(requests.filter(url => url.endsWith("/token"))).toHaveLength(3);
			expect(result.orgId).toBe(PROFILE_TWO);
		} finally {
			sleepSpy.mockRestore();
		}
	});

	it("prompts for a selected profile without exposing its ARN or account id", async () => {
		let prompt: OAuthPrompt | undefined;
		const selected = await selectKiroProfile("access-token", "us-east-1", {
			fetch: async () =>
				json({
					profiles: [
						{ arn: PROFILE_ONE, profileName: "Personal" },
						{ arn: PROFILE_TWO, profileName: "Work" },
					],
				}),
			onPrompt: async (options: OAuthPrompt) => {
				prompt = options;
				return "2";
			},
		});

		expect(selected).toEqual({ profileArn: PROFILE_TWO, profileName: "Work" });
		expect(prompt?.message).toContain("1. Personal");
		expect(prompt?.message).toContain("2. Work");
		expect(prompt?.placeholder).toBe("1");
		expect(JSON.stringify(prompt)).not.toContain("arn:");
		expect(JSON.stringify(prompt)).not.toContain("123456789012");
	});

	it("returns fresh credentials without network when outside the refresh margin", async () => {
		const current: OAuthCredentials = {
			...kiroClientCredentials(),
			access: "fresh-access",
			expires: Date.now() + 3_600_000,
		};
		let called = false;
		const result = await refreshKiroToken(current, {
			fetch: async () => {
				called = true;
				return json({ accessToken: "unexpected", expiresIn: 3600 });
			},
		});
		expect(result).toBe(current);
		expect(called).toBe(false);

		const viaHook = await refreshKiroHook(current);
		expect(viaHook).toBe(current);
	});

	it("rejects incomplete, expired, mismatched, or invalid refresh state without network", async () => {
		const cases: Array<{ name: string; credentials: OAuthCredentials }> = [
			{
				name: "missing token endpoint",
				credentials: kiroClientCredentials({ kiroTokenEndpoint: undefined }),
			},
			{
				name: "missing client id",
				credentials: kiroClientCredentials({ kiroClientId: undefined }),
			},
			{
				name: "expired registered client",
				credentials: kiroClientCredentials({ kiroClientSecretExpiresAt: Date.now() - 1 }),
			},
			{
				name: "endpoint does not match credential region",
				credentials: kiroClientCredentials({
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
					kiroOidcRegion: "eu-west-1",
				}),
			},
			{
				name: "invalid refresh endpoint",
				credentials: kiroClientCredentials({ kiroTokenEndpoint: "https://example.com/token" }),
			},
		];

		for (const { credentials } of cases) {
			let called = false;
			await expect(
				refreshKiroToken(credentials, {
					fetch: async () => {
						called = true;
						return json({ accessToken: "unexpected", expiresIn: 3600 });
					},
				}),
			).rejects.toMatchObject({ kind: expect.anything() });
			expect(called).toBe(false);
		}
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
				kiroOidcRegion: "eu-west-1",
				apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
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
			kiroOidcRegion: "eu-west-1",
			kiroTokenEndpoint: "https://oidc.eu-west-1.amazonaws.com/token",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			orgId: PROFILE_TWO,
			orgName: "Work",
		});
	});

	it("retries transient refresh failures but does not retry semantic client errors", async () => {
		const current = kiroClientCredentials();
		let transientAttempts = 0;
		const retried = await refreshKiroToken(current, {
			fetch: async () => {
				transientAttempts += 1;
				if (transientAttempts < 3)
					return json({ error: "temporarily unavailable" }, transientAttempts === 1 ? 503 : 429);
				return json({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
			},
		});
		expect(transientAttempts).toBe(3);
		expect(retried).toMatchObject({ access: "new-access", refresh: "new-refresh" });

		let semanticAttempts = 0;
		await expect(
			refreshKiroToken(current, {
				fetch: async () => {
					semanticAttempts += 1;
					return json({ error: "invalid client" }, 400);
				},
			}),
		).rejects.toMatchObject({ kind: "token-refresh", status: 400 });
		expect(semanticAttempts).toBe(1);
	});

	it("retains the old refresh token when rotation is omitted and rejects cancellation", async () => {
		const retained = await refreshKiroToken(kiroClientCredentials(), {
			fetch: async () => json({ accessToken: "new-access", expiresIn: 3600 }),
		});
		expect(retained.refresh).toBe("refresh-token");

		const controller = new AbortController();
		controller.abort();
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					signal: controller.signal,
					fetch: async () => json(registeredClient()),
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});

	it("fails closed on an oversized token response", async () => {
		await expect(
			refreshKiroToken(kiroClientCredentials(), {
				fetch: async () => new Response(`{"accessToken":"${"x".repeat(140_000)}"}`, { status: 200 }),
			}),
		).rejects.toThrow("exceeded size limit");
	});
});

describe("Kiro OAuth API-key projection", () => {
	it("serializes structured credentials for the native runtime transport", async () => {
		const result = await getOAuthApiKey("kiro", {
			kiro: {
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 3_600_000,
				apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			},
		});

		expect(result).not.toBeNull();
		expect(JSON.parse(result!.apiKey)).toMatchObject({
			token: "access-token",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			refreshToken: "refresh-token",
		});
		expect(result!.newCredentials.access).toBe("access-token");
	});
});

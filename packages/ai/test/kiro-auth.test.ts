import { describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { kiroProvider, selectKiroLoginMethod } from "@oh-my-pi/pi-ai/registry/kiro";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import {
	KIRO_IDENTITY_CENTER_SCOPES,
	loginKiroDevice,
	refreshKiroToken,
	selectKiroProfile,
	validateKiroApiKey,
} from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type { OAuthLoginCache, OAuthPrompt, OAuthSelectPrompt } from "@oh-my-pi/pi-ai/registry/oauth/types";
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

	it("uses typed method choices and does not start deferred Builder login", async () => {
		const selections: OAuthSelectPrompt[] = [];
		const progress: string[] = [];
		const result = await kiroProvider.login({
			onAuth: () => {},
			onProgress: message => progress.push(message),
			onPrompt: async () => {
				throw new Error("Builder selection must not use a text prompt");
			},
			onSelect: async prompt => {
				selections.push(prompt);
				return "builder";
			},
			fetch: async () => {
				throw new Error("Builder must not make a request");
			},
		});

		expect(result).toBe("");
		expect(selections).toEqual([
			{
				message: "Select Kiro login method",
				options: [
					{ value: "aws", label: "AWS" },
					{ value: "builder", label: "Builder" },
					{ value: "api", label: "API" },
				],
				defaultValue: "aws",
			},
		]);
		expect(progress).toEqual(["Builder ID login is not available yet."]);
	});

	it("does not silently choose AWS when the text fallback is empty", async () => {
		await expect(
			selectKiroLoginMethod({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);
	});

	it("routes API selection to the existing API-key validation path", async () => {
		const selections: OAuthSelectPrompt[] = [];
		const prompts: string[] = [];
		let called = false;
		await expect(
			kiroProvider.login({
				onAuth: () => {},
				onSelect: async prompt => {
					selections.push(prompt);
					return "api";
				},
				onPrompt: async prompt => {
					prompts.push(prompt.message);
					return "not-a-key";
				},
				fetch: async () => {
					called = true;
					return json(modelCatalog());
				},
			}),
		).rejects.toMatchObject({ kind: "validation" });
		expect(selections[0]?.options.map(option => option.value)).toEqual(["aws", "builder", "api"]);
		expect(prompts).toEqual(["Paste your Kiro API key"]);
		expect(called).toBe(false);
	});

	it("prompts for IAM Identity Center values, uses exact registration scopes, and reuses saved state", async () => {
		const { cache, values } = memoryCache();
		const prompts: OAuthPrompt[] = [];
		const authEvents: Array<{ url: string; userCode?: string; expiresAt?: number; instructions?: string }> = [];
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
		expect(authEvents).toHaveLength(1);
		expect(authEvents[0]).toMatchObject({
			url: "https://device.sso.aws.dev/complete",
			userCode: "ABCD-EFGH",
			instructions: "Confirm this code in the browser",
		});
		expect(authEvents[0]?.expiresAt).toBeGreaterThan(Date.now());
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
		expect(first.kiroTokenEndpoint).toBe("https://oidc.eu-west-1.amazonaws.com/token");
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

	it("uses the canonical regional token endpoint when fresh registration omits it", async () => {
		const { cache, values } = memoryCache();
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
				onPrompt: async () => "",
				fetch,
				cache,
				sleep: async () => {},
			},
			{ region: "eu-west-1", startUrl: "https://example.awsapps.com/start" },
		);

		expect(loggedIn.kiroTokenEndpoint).toBe(canonical);
		expect(requests.filter(url => url === canonical)).toHaveLength(1);
		const cached = values.get("oauth:kiro:iam-identity-center:registration:eu-west-1");
		expect(cached).toBeDefined();
		expect(JSON.parse(cached!)).toMatchObject({ tokenEndpoint: canonical });

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
		const { cache, values } = memoryCache();
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
				onPrompt: async () => "",
				fetch,
				cache,
				sleep: async () => {},
			},
			{ region: "eu-west-1", startUrl: "https://example.awsapps.com/start" },
		);

		expect(loggedIn.kiroTokenEndpoint).toBe(canonical);
		expect(requests.filter(url => url === canonical)).toHaveLength(1);
		expect(JSON.parse(values.get("oauth:kiro:iam-identity-center:registration:eu-west-1")!)).toMatchObject({
			tokenEndpoint: canonical,
		});
	});

	it("reuses and repairs cached registrations that omit tokenEndpoint or return null", async () => {
		for (const tokenEndpoint of [undefined, null]) {
			const { cache, values } = memoryCache();
			const canonical = "https://oidc.us-east-1.amazonaws.com/token";
			cache.set(
				"oauth:kiro:iam-identity-center:registration:us-east-1",
				JSON.stringify({
					registrationVersion: 1,
					region: "us-east-1",
					flow: "device_code",
					clientName: "Kiro CLI",
					scopes: [...KIRO_IDENTITY_CENTER_SCOPES],
					clientId: "cached-client",
					clientSecret: "cached-secret",
					clientSecretExpiresAt: Date.now() + 3_600_000,
					...(tokenEndpoint === undefined ? {} : { tokenEndpoint }),
				}),
				Math.floor(Date.now() / 1000) + 3_600,
			);
			let registrationRequests = 0;
			const requests: string[] = [];
			const profiles = profileResponses();
			const fetch: FetchImpl = async input => {
				const url = String(input);
				requests.push(url);
				if (url.endsWith("/client/register")) {
					registrationRequests += 1;
					return json(registeredClient());
				}
				if (url.endsWith("/device_authorization")) return json(deviceAuthorization());
				if (url.endsWith("/token")) {
					return json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 });
				}
				return url.includes("management") ? (profiles.shift() ?? json({ profiles: [] })) : json({}, 500);
			};

			const loggedIn = await loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					fetch,
					cache,
					sleep: async () => {},
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			);

			expect(registrationRequests).toBe(0);
			expect(requests.filter(url => url === canonical)).toHaveLength(1);
			expect(loggedIn.kiroTokenEndpoint).toBe(canonical);
			expect(JSON.parse(values.get("oauth:kiro:iam-identity-center:registration:us-east-1")!)).toMatchObject({
				tokenEndpoint: canonical,
			});
		}
	});

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
			const { cache } = memoryCache();
			await expect(
				loginKiroDevice(
					{
						onAuth: () => {},
						onPrompt: async () => "",
						cache,
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

	it("rejects an invalid present endpoint in the cache without registering a replacement", async () => {
		const { cache } = memoryCache();
		cache.set(
			"oauth:kiro:iam-identity-center:registration:us-east-1",
			JSON.stringify({
				registrationVersion: 1,
				region: "us-east-1",
				flow: "device_code",
				clientName: "Kiro CLI",
				scopes: [...KIRO_IDENTITY_CENTER_SCOPES],
				clientId: "cached-client",
				clientSecret: "cached-secret",
				clientSecretExpiresAt: Date.now() + 3_600_000,
				tokenEndpoint: "https://oidc.us-west-2.amazonaws.com/token",
			}),
			Math.floor(Date.now() / 1000) + 3_600,
		);
		let registrationRequests = 0;
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					cache,
					fetch: async input => {
						if (String(input).endsWith("/client/register")) {
							registrationRequests += 1;
						}
						return json(registeredClient());
					},
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			),
		).rejects.toMatchObject({ kind: "validation" });
		expect(registrationRequests).toBe(0);
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
			await authStorage.login("kiro", {
				onAuth: () => {},
				onPrompt: async prompt =>
					prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "us-east-1",
				onSelect: async prompt => (prompt.message === "Select Kiro login method" ? "aws" : "1"),
				fetch: async () => responses.shift() ?? json({}, 500),
				sleep: async () => {},
			});

			const stored = store.listAuthCredentials("kiro");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential).toMatchObject({
				type: "oauth",
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			});
		} finally {
			authStorage.close();
		}
	});

	it("treats a registered client with 59 seconds left as expired but reuses one with 61 seconds left", async () => {
		const run = async (remainingMs: number, expectedRegistrations: number): Promise<void> => {
			const { cache } = memoryCache();
			cache.set(
				"oauth:kiro:iam-identity-center:registration:us-east-1",
				JSON.stringify({
					registrationVersion: 1,
					region: "us-east-1",
					flow: "device_code",
					clientName: "Kiro CLI",
					scopes: [...KIRO_IDENTITY_CENTER_SCOPES],
					clientId: "cached-client",
					clientSecret: "cached-secret",
					clientSecretExpiresAt: Date.now() + remainingMs,
					tokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
				}),
				Math.floor(Date.now() / 1000) + 3_600,
			);
			const requests: string[] = [];
			let registrationRequests = 0;
			const profiles = profileResponses();
			const fetch: FetchImpl = async input => {
				const url = String(input);
				requests.push(url);
				if (url.endsWith("/client/register")) {
					registrationRequests += 1;
					return json(registeredClient());
				}
				if (url.endsWith("/device_authorization")) return json(deviceAuthorization());
				if (url.endsWith("/token")) {
					return json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 });
				}
				return url.includes("management")
					? (profiles.shift() ?? json({ profiles: [] }))
					: json({ error: "unexpected request" }, 500);
			};
			await loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					fetch,
					cache,
					sleep: async () => {},
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			);
			expect(registrationRequests).toBe(expectedRegistrations);
		};

		await run(59_000, 1);
		await run(61_000, 0);
	});

	it("limits registration, device authorization, and polling transport retries to three attempts", async () => {
		const cachedClient = (cache: OAuthLoginCache): void => {
			cache.set(
				"oauth:kiro:iam-identity-center:registration:us-east-1",
				JSON.stringify({
					registrationVersion: 1,
					region: "us-east-1",
					flow: "device_code",
					clientName: "Kiro CLI",
					scopes: [...KIRO_IDENTITY_CENTER_SCOPES],
					clientId: "cached-client",
					clientSecret: "cached-secret",
					clientSecretExpiresAt: Date.now() + 3_600_000,
					tokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
				}),
				Math.floor(Date.now() / 1000) + 3_600,
			);
		};
		const run = async (failureTarget: "registration" | "device" | "poll"): Promise<number> => {
			const { cache } = memoryCache();
			if (failureTarget !== "registration") cachedClient(cache);
			const counts = { registration: 0, device: 0, poll: 0 };
			const profiles = profileResponses();
			await loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					cache,
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
					sleep: async () => {},
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			);
			expect(counts[failureTarget]).toBe(3);
			return counts[failureTarget];
		};

		await run("registration");
		await run("device");
		await run("poll");
	});

	it("continues polling after RFC 8628 pending and slow_down responses", async () => {
		const { cache } = memoryCache();
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
				onPrompt: async () => {
					throw new Error("unexpected prompt");
				},
				fetch: async input => {
					requests.push(String(input));
					return responses.shift() ?? json({ error: "unexpected request" }, 500);
				},
				cache,
				sleep: async () => {},
			},
			{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
		);

		expect(requests.filter(url => url.endsWith("/token"))).toHaveLength(3);
		expect(result.orgId).toBe(PROFILE_TWO);
	});

	it("prompts for a selected profile without exposing its ARN or account id", async () => {
		let prompt: OAuthSelectPrompt | undefined;
		const selected = await selectKiroProfile("access-token", "us-east-1", {
			fetch: async () =>
				json({
					profiles: [
						{ arn: PROFILE_ONE, profileName: "Personal" },
						{ arn: PROFILE_TWO, profileName: "Work" },
					],
				}),
			onSelect: async options => {
				prompt = options;
				return "2";
			},
		});

		expect(selected).toEqual({ profileArn: PROFILE_TWO, profileName: "Work" });
		expect(prompt?.options).toEqual([
			{ value: "1", label: "Personal" },
			{ value: "2", label: "Work" },
		]);
		expect(prompt?.message).toBe("Select a Kiro profile");
		expect(JSON.stringify(prompt)).not.toContain("arn:");
		expect(JSON.stringify(prompt)).not.toContain("123456789012");
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

	it("retries transient refresh failures but does not retry semantic client errors", async () => {
		const current = {
			access: "old-access",
			refresh: "refresh-token",
			expires: 0,
			kiroClientId: "client-id",
			kiroClientSecret: "client-secret",
			kiroClientSecretExpiresAt: Date.now() + 60_000,
			kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			kiroAuthMethod: "device" as const,
		};
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

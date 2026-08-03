import type { KiroApiKeyBootstrapResult, KiroProfileSummary } from "@oh-my-pi/pi-catalog/discovery/kiro";
import {
	kiroManagementRequest,
	listKiroAvailableProfiles,
	probeKiroApiKeyBootstrap,
	sanitizeKiroModelCatalog,
} from "@oh-my-pi/pi-catalog/discovery/kiro";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	kiroRuntimeBaseUrl,
	parseKiroProfileArn,
	resolveKiroApiRegion,
	validateKiroApiRegion,
} from "@oh-my-pi/pi-catalog/wire/kiro";
import { BoundedJsonReadError, readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";
import * as AIError from "../../error";
import { throwIfKiroLoginCancelled } from "../kiro-cancellation";
import { OAuthCallbackFlow } from "./callback-server";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials, OAuthLoginCallbacks } from "./types";

const PROVIDER = "kiro";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const KIRO_SSO_REGIONS = [
	"us-east-1",
	"eu-central-1",
	"us-west-1",
	"us-west-2",
	"us-east-2",
	"ap-southeast-1",
	"ap-southeast-2",
	"ap-northeast-1",
	"ap-south-1",
	"eu-west-1",
	"eu-west-2",
	"eu-west-3",
	"eu-north-1",
	"eu-south-1",
	"eu-south-2",
	"eu-central-2",
] as const;
const AUTHORIZATION_CODE_GRANTS = ["authorization_code", "refresh_token"] as const;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface KiroRequestOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
	timeoutMs?: number;
	apiRegion?: string;
}

export interface KiroProfileSelectionOptions extends KiroRequestOptions {
	onPrompt?: OAuthController["onPrompt"];
}

export interface KiroBrowserConfig {
	issuerUrl: string;
	region?: string;
	preferredPort: number;
	scopes: readonly string[];
	clientName?: string;
	manualInputOnly?: boolean;
}

export interface KiroDeviceConfig {
	region?: string;
	clientName?: string;
	startUrl?: string;
	scopes?: readonly string[];
	maxPolls?: number;
	pollIntervalMs?: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, message: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AIError.OAuthError(message, { kind: "validation", provider: PROVIDER });
	}
	return value as JsonRecord;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new AIError.OAuthError(`Kiro response missing ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return value;
}

function positiveNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new AIError.OAuthError(`Kiro response has invalid ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return value;
}

function registeredClientExpiry(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new AIError.OAuthError("Kiro response has invalid clientSecretExpiresAt", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return value === 0 ? 0 : (value as number) * 1000;
}

async function request(
	url: string,
	init: RequestInit,
	options: KiroRequestOptions,
	kind: "http" | "token-exchange" | "token-refresh" | "device-auth" | "polling" = "http",
	bodyPolicy: "strict-json" | "allow-non-json-error" = "strict-json",
): Promise<{ response: Response; body: unknown }> {
	throwIfKiroLoginCancelled(options.signal);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		const response = await (options.fetch ?? fetch)(url, { ...init, signal });
		throwIfKiroLoginCancelled(options.signal);
		if (!response.ok && bodyPolicy === "allow-non-json-error") {
			await response.body?.cancel();
			return { response, body: undefined };
		}
		const body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
		return { response, body };
	} catch (cause) {
		throwIfKiroLoginCancelled(options.signal);
		if (timeout.aborted) {
			throw new AIError.OAuthError("Kiro request timed out", { kind: "timeout", provider: PROVIDER, cause });
		}
		if (cause instanceof BoundedJsonReadError) {
			const message =
				cause.kind === "size"
					? "Kiro response exceeded size limit"
					: cause.kind === "missing-body"
						? "Kiro response has no body"
						: "Kiro returned invalid JSON";
			throw new AIError.OAuthError(message, { kind: "validation", provider: PROVIDER, cause });
		}
		if (cause instanceof AIError.OAuthError) throw cause;
		throw new AIError.OAuthError("Kiro request failed", { kind, provider: PROVIDER, cause });
	}
}

function credentials(body: unknown, fallbackRefresh?: string): OAuthCredentials {
	const data = record(body, "Kiro returned invalid token data");
	const access = requiredString(data.accessToken, "accessToken");
	const refresh =
		data.refreshToken === undefined
			? requiredString(fallbackRefresh, "refreshToken")
			: requiredString(data.refreshToken, "refreshToken");
	const expiresIn = positiveNumber(data.expiresIn, "expiresIn");
	return { access, refresh, expires: Date.now() + expiresIn * 1000 };
}

function normalizeApiKey(input: string): string {
	const withoutControls = input.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	const first = withoutControls[0];
	const token =
		(first === '"' || first === "'" || first === "`") && withoutControls.at(-1) === first
			? withoutControls.slice(1, -1).trim()
			: withoutControls;
	if (!/^ksk_[A-Za-z0-9._~+/-]+$/.test(token)) {
		throw new AIError.OAuthError("Kiro API keys must use the ksk_… format", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return token;
}

export async function validateKiroApiKey(
	apiKey: string,
	options: KiroRequestOptions = {},
): Promise<{ type: "api_key"; key: string; apiEndpoint: string }> {
	const token = normalizeApiKey(apiKey);
	const explicitRegion = options.apiRegion === undefined ? undefined : validateKiroApiRegion(options.apiRegion);
	if (options.apiRegion !== undefined && !explicitRegion) {
		throw new AIError.OAuthError("KIRO_API_REGION is not a valid AWS region", {
			kind: "configuration",
			provider: PROVIDER,
		});
	}
	if (explicitRegion) {
		try {
			const payload = await kiroManagementRequest({
				apiRegion: explicitRegion,
				token,
				target: "ListAvailableModels",
				body: { origin: "KIRO_CLI" },
				fetch: options.fetch,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			});
			throwIfKiroLoginCancelled(options.signal);
			sanitizeKiroModelCatalog(payload);
			return { type: "api_key", key: token, apiEndpoint: kiroRuntimeBaseUrl(explicitRegion) };
		} catch (cause) {
			throwIfKiroLoginCancelled(options.signal);
			throw new AIError.OAuthError(`Kiro API key is not valid in ${explicitRegion}`, {
				kind: "discovery",
				provider: PROVIDER,
				cause,
			});
		}
	}

	let result: KiroApiKeyBootstrapResult | null;
	try {
		result = await probeKiroApiKeyBootstrap({ token, fetch: options.fetch, signal: options.signal });
		throwIfKiroLoginCancelled(options.signal);
	} catch (cause) {
		throwIfKiroLoginCancelled(options.signal);
		throw new AIError.OAuthError("Kiro API-key route discovery failed", {
			kind: "discovery",
			provider: PROVIDER,
			cause,
		});
	}
	if (!result) {
		throw new AIError.OAuthError(
			"Kiro API key did not resolve to exactly one route; set KIRO_API_REGION to the key's AWS region",
			{ kind: "discovery", provider: PROVIDER },
		);
	}
	try {
		sanitizeKiroModelCatalog(result.payload);
	} catch (cause) {
		throw new AIError.OAuthError("Kiro returned an invalid model catalog while validating the API key", {
			kind: "discovery",
			provider: PROVIDER,
			cause,
		});
	}
	return { type: "api_key", key: token, apiEndpoint: result.route.runtimeBaseUrl };
}

/**
 * Label a profile for the selection prompt without echoing its ARN: the ARN
 * embeds the AWS account id, which must never reach the terminal or logs.
 */
function profileLabel(profile: KiroProfileSummary, index: number): string {
	if (profile.profileName) return `${index + 1}. ${profile.profileName}`;
	const region = parseKiroProfileArn(profile.arn)?.apiRegion;
	return `${index + 1}. ${region ? `profile in ${region}` : "unnamed profile"}`;
}

export async function selectKiroProfile(
	token: string,
	apiRegion: string,
	options: KiroProfileSelectionOptions = {},
): Promise<{ profileArn: string; profileName: string | undefined }> {
	let profiles: KiroProfileSummary[];
	try {
		profiles = await listKiroAvailableProfiles({ apiRegion, token, fetch: options.fetch, signal: options.signal });
		throwIfKiroLoginCancelled(options.signal);
	} catch (cause) {
		throwIfKiroLoginCancelled(options.signal);
		throw new AIError.OAuthError("Unable to discover Kiro profiles", {
			kind: "discovery",
			provider: PROVIDER,
			cause,
		});
	}
	if (profiles.length === 0) {
		throw new AIError.OAuthError("No Kiro profiles are available", { kind: "discovery", provider: PROVIDER });
	}
	let selected = profiles[0]!;
	if (profiles.length > 1) {
		if (!options.onPrompt) throw new AIError.OnPromptRequiredError("Kiro profile selection");
		const choices = profiles.map((profile, index) => profileLabel(profile, index)).join("\n");
		const answer = await options.onPrompt({
			message: `Select a Kiro profile:\n${choices}`,
			placeholder: "1",
		});
		throwIfKiroLoginCancelled(options.signal);
		const index = Number.parseInt(answer.trim(), 10) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= profiles.length) {
			throw new AIError.OAuthError("Invalid Kiro profile selection", { kind: "validation", provider: PROVIDER });
		}
		selected = profiles[index]!;
	}
	return { profileArn: selected.arn, profileName: selected.profileName };
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

interface KiroRegisteredClient {
	clientId: string;
	clientSecret: string;
	clientSecretExpiresAt: number | undefined;
	authorizationEndpoint: string;
	tokenEndpoint: string;
}

function validateStartUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new AIError.OAuthError("Invalid AWS access portal URL", { kind: "validation", provider: PROVIDER });
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.port !== "" ||
		(parsed.hostname !== "view.awsapps.com" && !parsed.hostname.endsWith(".awsapps.com")) ||
		parsed.pathname !== "/start" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new AIError.OAuthError("Invalid AWS access portal URL", { kind: "validation", provider: PROVIDER });
	}
	return parsed.toString();
}

function validateOidcEndpoint(value: unknown, region: string, path: "/authorize" | "/token", field: string): string {
	const endpoint = requiredString(value, field);
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch (cause) {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, {
			kind: "validation",
			provider: PROVIDER,
			cause,
		});
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== `oidc.${region}.amazonaws.com` ||
		parsed.port !== "" ||
		parsed.pathname !== path ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return parsed.toString();
}

function parseRegisteredClient(body: unknown, region: string): KiroRegisteredClient {
	const registration = record(body, "Invalid Kiro client registration");
	return {
		clientId: requiredString(registration.clientId, "clientId"),
		clientSecret: requiredString(registration.clientSecret, "clientSecret"),
		clientSecretExpiresAt: registeredClientExpiry(registration.clientSecretExpiresAt),
		authorizationEndpoint: validateOidcEndpoint(
			registration.authorizationEndpoint ?? `https://oidc.${region}.amazonaws.com/authorize`,
			region,
			"/authorize",
			"authorizationEndpoint",
		),
		tokenEndpoint: validateOidcEndpoint(
			registration.tokenEndpoint ?? `https://oidc.${region}.amazonaws.com/token`,
			region,
			"/token",
			"tokenEndpoint",
		),
	};
}

async function registerBrowserClient(
	ctrl: OAuthController,
	config: KiroBrowserConfig,
	region: string,
	redirectUri: string,
): Promise<KiroRegisteredClient | undefined> {
	const registered = await request(
		`https://oidc.${region}.amazonaws.com/client/register`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				clientName: config.clientName ?? "oh-my-pi",
				clientType: "public",
				scopes: config.scopes,
				grantTypes: AUTHORIZATION_CODE_GRANTS,
				issuerUrl: config.issuerUrl,
				redirectUris: [redirectUri],
			}),
		},
		{ fetch: ctrl.fetch, signal: ctrl.signal },
		"device-auth",
		"allow-non-json-error",
	);
	return registered.response.ok ? parseRegisteredClient(registered.body, region) : undefined;
}

class KiroBrowserFlow extends OAuthCallbackFlow {
	readonly #config: KiroBrowserConfig;
	#verifier = "";
	#client: KiroRegisteredClient | undefined;
	#region: string | undefined;

	constructor(ctrl: OAuthController, config: KiroBrowserConfig) {
		super(ctrl, {
			preferredPort: config.preferredPort,
			callbackPath: "/oauth/callback",
			manualInputOnly: config.manualInputOnly,
		});
		this.#config = config;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		for (const region of this.#config.region ? [this.#config.region] : KIRO_SSO_REGIONS) {
			const client = await registerBrowserClient(this.ctrl, this.#config, region, redirectUri);
			if (!client) continue;
			this.#client = client;
			this.#region = region;
			break;
		}
		if (!this.#client || !this.#region) {
			throw new AIError.OAuthError("No supported AWS region accepted this access portal", {
				kind: "discovery",
				provider: PROVIDER,
			});
		}
		this.#verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = base64Url(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.#verifier))),
		);
		const url = new URL(this.#client.authorizationEndpoint);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: this.#client.clientId,
			redirect_uri: redirectUri,
			scope: this.#config.scopes.join(" "),
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		return { url: url.toString() };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const verifier = this.#verifier;
		const client = this.#client;
		const region = this.#region;
		this.#verifier = "";
		if (!verifier || !client || !region) {
			throw new AIError.OAuthError("Kiro browser authorization state was already consumed", {
				kind: "validation",
				provider: PROVIDER,
			});
		}
		const token = await request(
			client.tokenEndpoint,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					clientId: client.clientId,
					clientSecret: client.clientSecret,
					code,
					codeVerifier: verifier,
					grantType: "authorization_code",
					redirectUri,
				}),
			},
			{ fetch: this.ctrl.fetch, signal: this.ctrl.signal },
			"token-exchange",
		);
		if (!token.response.ok) {
			throw new AIError.OAuthError(`Kiro token exchange failed: HTTP ${token.response.status}`, {
				kind: "token-exchange",
				provider: PROVIDER,
				status: token.response.status,
			});
		}
		const result = credentials(token.body);
		const selected = await selectKiroProfile(result.access, resolveKiroApiRegion(region), {
			fetch: this.ctrl.fetch,
			signal: this.ctrl.signal,
			onPrompt: this.ctrl.onPrompt,
		});
		return {
			...result,
			kiroClientId: client.clientId,
			kiroClientSecret: client.clientSecret,
			kiroClientSecretExpiresAt: client.clientSecretExpiresAt,
			kiroTokenEndpoint: client.tokenEndpoint,
			kiroAuthMethod: "browser",
			orgId: selected.profileArn,
			orgName: selected.profileName,
		};
	}
}

export async function loginKiroBrowser(
	ctrl: OAuthLoginCallbacks,
	config: KiroBrowserConfig,
): Promise<OAuthCredentials> {
	const region = config.region === undefined ? undefined : validateKiroApiRegion(config.region);
	if ((config.region !== undefined && !region) || config.scopes.length === 0) {
		throw new AIError.OAuthError("Invalid Kiro browser configuration", { kind: "configuration", provider: PROVIDER });
	}
	const result = await new KiroBrowserFlow(ctrl, {
		...config,
		issuerUrl: validateStartUrl(config.issuerUrl),
		region,
	}).login();
	throwIfKiroLoginCancelled(ctrl.signal);
	return result;
}

interface KiroDeviceAuthorization {
	client: KiroRegisteredClient;
	region: string;
	device: JsonRecord;
}

async function tryDeviceAuthorization(
	ctrl: OAuthLoginCallbacks,
	config: KiroDeviceConfig,
	region: string,
	startUrl: string,
): Promise<KiroDeviceAuthorization | undefined> {
	const host = `https://oidc.${region}.amazonaws.com`;
	const registered = await request(
		`${host}/client/register`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				clientName: config.clientName ?? "oh-my-pi",
				clientType: "public",
				scopes: config.scopes ?? [],
			}),
		},
		{ fetch: ctrl.fetch, signal: ctrl.signal },
		"device-auth",
		"allow-non-json-error",
	);
	if (!registered.response.ok) return undefined;
	const client = parseRegisteredClient(registered.body, region);
	const authorized = await request(
		`${host}/device_authorization`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, startUrl }),
		},
		{ fetch: ctrl.fetch, signal: ctrl.signal },
		"device-auth",
		"allow-non-json-error",
	);
	if (!authorized.response.ok) return undefined;
	return { client, region, device: record(authorized.body, "Invalid Kiro device authorization response") };
}

export async function loginKiroDevice(ctrl: OAuthLoginCallbacks, config: KiroDeviceConfig): Promise<OAuthCredentials> {
	const explicitRegion = config.region === undefined ? undefined : validateKiroApiRegion(config.region);
	if (config.region !== undefined && !explicitRegion) {
		throw new AIError.OAuthError("Invalid Kiro device region", { kind: "configuration", provider: PROVIDER });
	}
	const startUrl = validateStartUrl(config.startUrl ?? BUILDER_ID_START_URL);
	let authorization: KiroDeviceAuthorization | undefined;
	for (const region of explicitRegion ? [explicitRegion] : KIRO_SSO_REGIONS) {
		authorization = await tryDeviceAuthorization(ctrl, config, region, startUrl);
		if (authorization) break;
	}
	if (!authorization) {
		throw new AIError.OAuthError("No supported AWS region accepted this access portal", {
			kind: "discovery",
			provider: PROVIDER,
		});
	}
	const { client, region, device } = authorization;
	const deviceCode = requiredString(device.deviceCode, "deviceCode");
	const verificationUri = requiredString(device.verificationUriComplete ?? device.verificationUri, "verificationUri");
	ctrl.onAuth({ url: verificationUri, instructions: `Enter code ${requiredString(device.userCode, "userCode")}` });
	throwIfKiroLoginCancelled(ctrl.signal);
	const expiresMs = positiveNumber(device.expiresIn, "expiresIn") * 1000;
	const intervalMs = config.pollIntervalMs ?? positiveNumber(device.interval, "interval") * 1000;
	const completed = await pollOAuthDeviceCodeFlow<OAuthCredentials>({
		poll: async () => {
			const polled = await request(
				client.tokenEndpoint,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						grantType: DEVICE_CODE_GRANT,
						deviceCode,
						clientId: client.clientId,
						clientSecret: client.clientSecret,
					}),
				},
				{ fetch: ctrl.fetch, signal: ctrl.signal },
				"polling",
			);
			const pollBody = record(polled.body, "Invalid Kiro polling response");
			if (pollBody.error === "authorization_pending") return { status: "pending" as const };
			if (pollBody.error === "slow_down") return { status: "slow_down" as const };
			if (!polled.response.ok || pollBody.error) {
				throw new AIError.OAuthError(
					`Kiro device authorization rejected: ${String(pollBody.error ?? polled.response.status)}`,
					{
						kind: "device-auth",
						provider: PROVIDER,
						status: polled.response.status,
					},
				);
			}
			return { status: "complete" as const, value: credentials(pollBody) };
		},
		intervalSeconds: intervalMs / 1000,
		expiresInSeconds: expiresMs / 1000,
		signal: ctrl.signal,
	});
	throwIfKiroLoginCancelled(ctrl.signal);
	const selected = await selectKiroProfile(completed.access, resolveKiroApiRegion(region), {
		fetch: ctrl.fetch,
		signal: ctrl.signal,
		onPrompt: ctrl.onPrompt,
	});
	throwIfKiroLoginCancelled(ctrl.signal);
	return {
		...completed,
		kiroClientId: client.clientId,
		kiroClientSecret: client.clientSecret,
		kiroClientSecretExpiresAt: client.clientSecretExpiresAt,
		kiroTokenEndpoint: client.tokenEndpoint,
		kiroAuthMethod: "device",
		orgId: selected.profileArn,
		orgName: selected.profileName,
	};
}

export async function refreshKiroToken(
	current: OAuthCredentials,
	options: KiroRequestOptions = {},
): Promise<OAuthCredentials> {
	const endpoint = current.kiroTokenEndpoint;
	const method = current.kiroAuthMethod;
	if (!endpoint || !method) {
		throw new AIError.OAuthError("Kiro refresh state is incomplete", { kind: "configuration", provider: PROVIDER });
	}
	if (!current.kiroClientId || !current.kiroClientSecret) {
		throw new AIError.OAuthError("Kiro refresh requires registered-client credentials", {
			kind: "configuration",
			provider: PROVIDER,
		});
	}
	if (
		current.kiroClientSecretExpiresAt !== undefined &&
		current.kiroClientSecretExpiresAt !== 0 &&
		current.kiroClientSecretExpiresAt <= Date.now()
	) {
		throw new AIError.OAuthError("Kiro registered client expired; run /login kiro again", {
			kind: "token-refresh",
			provider: PROVIDER,
		});
	}
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch (cause) {
		throw new AIError.OAuthError("Invalid Kiro refresh endpoint", {
			kind: "configuration",
			provider: PROVIDER,
			cause,
		});
	}
	if (
		parsed.protocol !== "https:" ||
		!/^oidc\.[a-z]{2}(?:-[a-z0-9]+)+-\d+\.amazonaws\.com$/.test(parsed.hostname) ||
		parsed.pathname !== "/token" ||
		parsed.port !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new AIError.OAuthError("Invalid Kiro refresh endpoint", { kind: "configuration", provider: PROVIDER });
	}
	const response = await request(
		endpoint,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				grantType: "refresh_token",
				refreshToken: current.refresh,
				clientId: current.kiroClientId,
				clientSecret: current.kiroClientSecret,
			}),
		},
		options,
		"token-refresh",
	);
	if (!response.response.ok) {
		throw new AIError.OAuthError(`Kiro refresh failed: HTTP ${response.response.status}`, {
			kind: "token-refresh",
			provider: PROVIDER,
			status: response.response.status,
		});
	}
	return {
		...credentials(response.body, current.refresh),
		kiroClientId: current.kiroClientId,
		kiroClientSecret: current.kiroClientSecret,
		kiroClientSecretExpiresAt: current.kiroClientSecretExpiresAt,
		kiroTokenEndpoint: endpoint,
		kiroAuthMethod: method,
		orgId: current.orgId,
		orgName: current.orgName,
	};
}

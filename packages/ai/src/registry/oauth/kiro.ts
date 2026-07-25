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
import * as AIError from "../../error";
import { OAuthCallbackFlow } from "./callback-server";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials, OAuthLoginCallbacks } from "./types";

const PROVIDER = "kiro";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

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
	region: string;
	clientId: string;
	preferredPort: number;
	scopes: readonly string[];
	manualInputOnly?: boolean;
}

export interface KiroDeviceConfig {
	kind: "builder-id" | "google" | "github";
	region: string;
	appId?: string;
	clientName?: string;
	startUrl?: string;
	scopes?: readonly string[];
	maxPolls?: number;
	pollIntervalMs?: number;
}

type JsonRecord = Record<string, unknown>;

interface KiroDevicePollCompletion {
	result: OAuthCredentials;
	pollBody: JsonRecord;
}

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

async function boundedJson(response: Response): Promise<unknown> {
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
		throw new AIError.OAuthError("Kiro response exceeded size limit", { kind: "validation", provider: PROVIDER });
	}
	const reader = response.body?.getReader();
	if (!reader) throw new AIError.OAuthError("Kiro response has no body", { kind: "validation", provider: PROVIDER });
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => {});
			throw new AIError.OAuthError("Kiro response exceeded size limit", { kind: "validation", provider: PROVIDER });
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch (cause) {
		throw new AIError.OAuthError("Kiro returned invalid JSON", { kind: "validation", provider: PROVIDER, cause });
	}
}

async function request(
	url: string,
	init: RequestInit,
	options: KiroRequestOptions,
	kind: "http" | "token-exchange" | "token-refresh" | "device-auth" | "polling" = "http",
): Promise<{ response: Response; body: unknown }> {
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		const response = await (options.fetch ?? fetch)(url, { ...init, signal });
		const body = await boundedJson(response);
		return { response, body };
	} catch (cause) {
		if (options.signal?.aborted) throw new AIError.LoginCancelledError();
		if (timeout.aborted)
			throw new AIError.OAuthError("Kiro request timed out", { kind: "timeout", provider: PROVIDER, cause });
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
			sanitizeKiroModelCatalog(payload);
			return { type: "api_key", key: token, apiEndpoint: kiroRuntimeBaseUrl(explicitRegion) };
		} catch (cause) {
			if (options.signal?.aborted) throw new AIError.LoginCancelledError();
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
	} catch (cause) {
		if (options.signal?.aborted) throw new AIError.LoginCancelledError();
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

export async function selectKiroProfile(
	token: string,
	apiRegion: string,
	options: KiroProfileSelectionOptions = {},
): Promise<{ profileArn: string; profileName: string | undefined }> {
	let profiles: KiroProfileSummary[];
	try {
		profiles = await listKiroAvailableProfiles({ apiRegion, token, fetch: options.fetch, signal: options.signal });
	} catch (cause) {
		if (options.signal?.aborted) throw new AIError.LoginCancelledError();
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
		const answer = await options.onPrompt({
			message: `Select a Kiro profile (1-${profiles.length})`,
			placeholder: "1",
		});
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

class KiroBrowserFlow extends OAuthCallbackFlow {
	readonly config: KiroBrowserConfig;
	verifier = "";

	constructor(ctrl: OAuthController, config: KiroBrowserConfig) {
		super(ctrl, { preferredPort: config.preferredPort, manualInputOnly: config.manualInputOnly });
		this.config = config;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
		this.verifier = base64Url(verifierBytes);
		const challenge = base64Url(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.verifier))),
		);
		const url = new URL(`https://auth.${this.config.region}.kiro.dev/authorize`);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: this.config.clientId,
			redirect_uri: redirectUri,
			scope: this.config.scopes.join(" "),
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		return { url: url.toString() };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const verifier = this.verifier;
		this.verifier = "";
		if (!verifier)
			throw new AIError.OAuthError("Kiro PKCE verifier was already consumed", {
				kind: "validation",
				provider: PROVIDER,
			});
		const tokenEndpoint = `https://auth.${this.config.region}.kiro.dev/oauth/token`;
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: this.config.clientId,
			code_verifier: verifier,
		});
		const result = await request(
			tokenEndpoint,
			{ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
			{ fetch: this.ctrl.fetch, signal: this.ctrl.signal },
			"token-exchange",
		);
		if (!result.response.ok)
			throw new AIError.OAuthError(`Kiro token exchange failed: HTTP ${result.response.status}`, {
				kind: "token-exchange",
				provider: PROVIDER,
				status: result.response.status,
			});
		const resultCredentials = credentials(result.body);
		const selected = await selectKiroProfile(resultCredentials.access, resolveKiroApiRegion(this.config.region), {
			fetch: this.ctrl.fetch,
			signal: this.ctrl.signal,
			onPrompt: this.ctrl.onPrompt,
		});
		return {
			...resultCredentials,
			kiroClientId: this.config.clientId,
			kiroTokenEndpoint: tokenEndpoint,
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
	if (!validateKiroApiRegion(config.region) || !config.clientId || config.scopes.length === 0) {
		throw new AIError.OAuthError("Invalid Kiro browser configuration", { kind: "configuration", provider: PROVIDER });
	}
	return new KiroBrowserFlow(ctrl, config).login();
}

export async function loginKiroDevice(ctrl: OAuthLoginCallbacks, config: KiroDeviceConfig): Promise<OAuthCredentials> {
	const region = validateKiroApiRegion(config.region);
	if (!region)
		throw new AIError.OAuthError("Invalid Kiro device region", { kind: "configuration", provider: PROVIDER });
	let clientId = config.appId;
	let clientSecret: string | undefined;
	let clientSecretExpiresAt: number | undefined;
	let tokenUrl: string;
	let authorizationUrl: string;
	let authorizationBody: RequestInit["body"];
	let authorizationHeaders: Record<string, string>;
	if (config.kind === "builder-id") {
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
		);
		if (!registered.response.ok)
			throw new AIError.OAuthError("Kiro client registration failed", {
				kind: "device-auth",
				provider: PROVIDER,
				status: registered.response.status,
			});
		const registration = record(registered.body, "Invalid Kiro client registration");
		clientId = requiredString(registration.clientId, "clientId");
		clientSecret = requiredString(registration.clientSecret, "clientSecret");
		clientSecretExpiresAt = registeredClientExpiry(registration.clientSecretExpiresAt);
		tokenUrl = typeof registration.tokenEndpoint === "string" ? registration.tokenEndpoint : `${host}/token`;
		authorizationUrl = `${host}/device_authorization`;
		authorizationHeaders = { "content-type": "application/json" };
		authorizationBody = JSON.stringify({
			clientId,
			clientSecret,
			startUrl: config.startUrl ?? "https://view.awsapps.com/start",
		});
	} else {
		if (!clientId)
			throw new AIError.OAuthError("Kiro desktop appId is required", { kind: "configuration", provider: PROVIDER });
		const host = `https://prod.${region}.auth.desktop.kiro.dev`;
		tokenUrl = `${host}/oauth/device/poll`;
		authorizationUrl = `${host}/oauth/device/authorization`;
		authorizationHeaders = { "content-type": "application/json" };
		authorizationBody = JSON.stringify({
			appId: clientId,
			loginProvider: config.kind === "google" ? "Google" : "GitHub",
		});
	}
	const authorized = await request(
		authorizationUrl,
		{ method: "POST", headers: authorizationHeaders, body: authorizationBody },
		{ fetch: ctrl.fetch, signal: ctrl.signal },
		"device-auth",
	);
	if (!authorized.response.ok)
		throw new AIError.OAuthError("Kiro device authorization failed", {
			kind: "device-auth",
			provider: PROVIDER,
			status: authorized.response.status,
		});
	const device = record(authorized.body, "Invalid Kiro device authorization response");
	const deviceCode = requiredString(device.deviceCode, "deviceCode");
	const verificationUri = requiredString(device.verificationUriComplete ?? device.verificationUri, "verificationUri");
	ctrl.onAuth({ url: verificationUri, instructions: `Enter code ${requiredString(device.userCode, "userCode")}` });
	const expiresMs =
		config.kind === "builder-id"
			? positiveNumber(device.expiresIn, "expiresIn") * 1000
			: positiveNumber(device.expiresInMilliseconds, "expiresInMilliseconds");
	const intervalMs =
		config.pollIntervalMs ??
		(config.kind === "builder-id"
			? positiveNumber(device.interval, "interval") * 1000
			: positiveNumber(device.intervalInMilliseconds, "intervalInMilliseconds"));
	const maxPolls = Math.min(config.maxPolls ?? Math.ceil(expiresMs / Math.max(intervalMs, 1)), 600);
	const pollInit =
		config.kind === "builder-id"
			? {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						grantType: "urn:ietf:params:oauth:grant-type:device_code",
						deviceCode,
						clientId: clientId!,
						clientSecret: clientSecret!,
					}),
				}
			: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ deviceCode, appId: clientId }),
				};
	const completed = await pollOAuthDeviceCodeFlow<KiroDevicePollCompletion>({
		poll: async () => {
			const polled = await request(tokenUrl, pollInit, { fetch: ctrl.fetch, signal: ctrl.signal }, "polling");
			const pollBody = record(polled.body, "Invalid Kiro polling response");
			const pollStatus = pollBody.error ?? pollBody.status;
			if (pollStatus === "authorization_pending") return { status: "pending" as const };
			if (pollStatus === "slow_down") return { status: "slow_down" as const };
			if (!polled.response.ok || pollBody.error) {
				throw new AIError.OAuthError(
					`Kiro device authorization rejected: ${String(pollStatus ?? polled.response.status)}`,
					{ kind: "device-auth", provider: PROVIDER, status: polled.response.status },
				);
			}
			return { status: "complete" as const, value: { result: credentials(pollBody), pollBody } };
		},
		intervalMilliseconds: intervalMs,
		expiresInSeconds: expiresMs / 1000,
		maxAttempts: maxPolls,
		signal: ctrl.signal,
	});
	const { result, pollBody } = completed;
	let selected: { profileArn: string; profileName: string | undefined };
	if (typeof pollBody.profileArn === "string") {
		const parsed = parseKiroProfileArn(pollBody.profileArn);
		if (!parsed)
			throw new AIError.OAuthError("Kiro returned an invalid profile ARN", {
				kind: "validation",
				provider: PROVIDER,
			});
		selected = { profileArn: parsed.profileArn, profileName: undefined };
	} else {
		selected = await selectKiroProfile(result.access, resolveKiroApiRegion(region), {
			fetch: ctrl.fetch,
			signal: ctrl.signal,
			onPrompt: ctrl.onPrompt,
		});
	}
	const refreshEndpoint =
		config.kind === "builder-id" ? tokenUrl : `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
	return {
		...result,
		kiroClientId: clientId,
		kiroClientSecret: clientSecret,
		kiroClientSecretExpiresAt: clientSecretExpiresAt,
		kiroTokenEndpoint: refreshEndpoint,
		kiroAuthMethod: config.kind,
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
	let body: RequestInit["body"];
	let headers: Record<string, string>;
	if (method === "builder-id") {
		if (!current.kiroClientId || !current.kiroClientSecret) {
			throw new AIError.OAuthError("Kiro Builder ID refresh requires registered-client credentials", {
				kind: "configuration",
				provider: PROVIDER,
			});
		}
		if (current.kiroClientSecretExpiresAt && current.kiroClientSecretExpiresAt <= Date.now()) {
			throw new AIError.OAuthError("Kiro Builder ID registered client expired; run /login kiro again", {
				kind: "token-refresh",
				provider: PROVIDER,
			});
		}
		const parsed = new URL(endpoint);
		if (
			parsed.protocol !== "https:" ||
			!/^oidc\.[a-z]{2}(?:-[a-z0-9]+)+-\d+\.amazonaws\.com$/.test(parsed.hostname) ||
			parsed.pathname !== "/token"
		) {
			throw new AIError.OAuthError("Invalid Kiro Builder ID refresh endpoint", {
				kind: "configuration",
				provider: PROVIDER,
			});
		}
		headers = { "content-type": "application/json" };
		body = JSON.stringify({
			grantType: "refresh_token",
			refreshToken: current.refresh,
			clientId: current.kiroClientId,
			clientSecret: current.kiroClientSecret,
		});
	} else if (method === "google" || method === "github") {
		const parsed = new URL(endpoint);
		if (
			parsed.protocol !== "https:" ||
			!/^prod\.[a-z]{2}(?:-[a-z0-9]+)+-\d+\.auth\.desktop\.kiro\.dev$/.test(parsed.hostname) ||
			parsed.pathname !== "/refreshToken"
		) {
			throw new AIError.OAuthError("Invalid Kiro desktop refresh endpoint", {
				kind: "configuration",
				provider: PROVIDER,
			});
		}
		headers = { "content-type": "application/json" };
		body = JSON.stringify({ refreshToken: current.refresh });
	} else if (method === "browser") {
		if (!current.kiroClientId)
			throw new AIError.OAuthError("Kiro browser refresh requires a client ID", {
				kind: "configuration",
				provider: PROVIDER,
			});
		const parsed = new URL(endpoint);
		if (
			parsed.protocol !== "https:" ||
			!/^auth\.[a-z]{2}(?:-[a-z0-9]+)+-\d+\.kiro\.dev$/.test(parsed.hostname) ||
			parsed.pathname !== "/oauth/token"
		) {
			throw new AIError.OAuthError("Invalid Kiro browser refresh endpoint", {
				kind: "configuration",
				provider: PROVIDER,
			});
		}
		headers = { "content-type": "application/x-www-form-urlencoded" };
		body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: current.refresh,
			client_id: current.kiroClientId,
		});
	} else {
		throw new AIError.OAuthError("Invalid Kiro authentication method", {
			kind: "configuration",
			provider: PROVIDER,
		});
	}
	const response = await request(endpoint, { method: "POST", headers, body }, options, "token-refresh");
	if (!response.response.ok)
		throw new AIError.OAuthError(`Kiro refresh failed: HTTP ${response.response.status}`, {
			kind: "token-refresh",
			provider: PROVIDER,
			status: response.response.status,
		});
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

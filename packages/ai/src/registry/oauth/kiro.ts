import type { KiroApiKeyBootstrapResult, KiroProfileSummary } from "@oh-my-pi/pi-catalog/discovery/kiro";
import {
	kiroManagementRequest,
	listKiroAvailableProfiles,
	probeKiroApiKeyBootstrap,
	sanitizeKiroModelCatalog,
} from "@oh-my-pi/pi-catalog/discovery/kiro";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	KIRO_BOOTSTRAP_REGIONS,
	kiroRuntimeBaseUrl,
	parseKiroProfileArn,
	validateKiroApiRegion,
} from "@oh-my-pi/pi-catalog/wire/kiro";
import { BoundedJsonReadError, readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import * as AIError from "../../error";
import { throwIfKiroLoginCancelled } from "../kiro-cancellation";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials, OAuthLoginCache, OAuthLoginCallbacks } from "./types";

const PROVIDER = "kiro";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const KIRO_CLIENT_NAME = "Kiro CLI";
const KIRO_REGISTRATION_VERSION = 1;
const KIRO_PROMPT_CACHE_KEY = "oauth:kiro:iam-identity-center:prompt-defaults";
const KIRO_REGISTRATION_CACHE_PREFIX = "oauth:kiro:iam-identity-center:registration:";
const KIRO_CACHE_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const KIRO_REFRESH_MARGIN_MS = 60_000;
export const KIRO_AUTH_MAX_ATTEMPTS = 3;
export const KIRO_REGISTRATION_EXPIRY_MARGIN_MS = 60_000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export const KIRO_IDENTITY_CENTER_SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations",
] as const;

export interface KiroRequestOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
	timeoutMs?: number;
	apiRegion?: string;
}

export interface KiroProfileSelectionOptions extends KiroRequestOptions {
	onPrompt?: OAuthController["onPrompt"];
	onSelect?: OAuthController["onSelect"];
}

export interface KiroDeviceConfig {
	region?: string;
	startUrl?: string;
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

function registeredClientExpiry(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new AIError.OAuthError("Kiro response has invalid clientSecretExpiresAt", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return value === 0 ? 0 : (value as number) * 1000;
}

class KiroTransportError extends Error {
	readonly originalCause: unknown;

	constructor(cause: unknown) {
		super("Kiro request failed");
		this.name = "KiroTransportError";
		this.originalCause = cause;
	}
}

function retryableHttpStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

function retryableRequestError(error: unknown): boolean {
	return error instanceof KiroTransportError || (error instanceof AIError.OAuthError && error.kind === "timeout");
}

async function requestOnce(
	url: string,
	init: RequestInit,
	options: KiroRequestOptions,
	bodyPolicy: "strict-json" | "allow-non-json-error" = "strict-json",
): Promise<{ response: Response; body: unknown }> {
	throwIfKiroLoginCancelled(options.signal);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		const response = await (options.fetch ?? fetch)(url, { ...init, signal });
		throwIfKiroLoginCancelled(options.signal);
		if (retryableHttpStatus(response.status)) {
			await response.body?.cancel();
			return { response, body: undefined };
		}
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
		throw new KiroTransportError(cause);
	}
}

async function request(
	url: string,
	init: RequestInit,
	options: KiroRequestOptions,
	kind: "http" | "token-exchange" | "token-refresh" | "device-auth" | "polling" = "http",
	bodyPolicy: "strict-json" | "allow-non-json-error" = "strict-json",
): Promise<{ response: Response; body: unknown }> {
	for (let attempt = 0; attempt < KIRO_AUTH_MAX_ATTEMPTS; attempt += 1) {
		throwIfKiroLoginCancelled(options.signal);
		try {
			const result = await requestOnce(url, init, options, bodyPolicy);
			if (!retryableHttpStatus(result.response.status) || attempt === KIRO_AUTH_MAX_ATTEMPTS - 1) {
				return result;
			}
		} catch (cause) {
			throwIfKiroLoginCancelled(options.signal);
			if (!retryableRequestError(cause) || attempt === KIRO_AUTH_MAX_ATTEMPTS - 1) {
				if (cause instanceof KiroTransportError) {
					throw new AIError.OAuthError("Kiro request failed", {
						kind,
						provider: PROVIDER,
						cause: cause.originalCause,
					});
				}
				throw cause;
			}
		}
	}
	throw new AIError.OAuthError("Kiro request failed", { kind, provider: PROVIDER });
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
function profileLabel(profile: KiroProfileSummary): string {
	const profileName = sanitizeText(profile.profileName ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 128);
	if (profileName) return profileName;
	const region = parseKiroProfileArn(profile.arn)?.apiRegion;
	return region ? `Profile in ${region}` : "Unnamed profile";
}

async function chooseKiroProfile(
	profiles: KiroProfileSummary[],
	signal: AbortSignal | undefined,
	options: KiroProfileSelectionOptions,
): Promise<{ profileArn: string; profileName: string | undefined }> {
	if (profiles.length === 0) {
		throw new AIError.OAuthError("No Kiro profiles are available", { kind: "discovery", provider: PROVIDER });
	}
	let selected = profiles[0]!;
	if (profiles.length > 1) {
		const optionsForSelect = profiles.map((profile, index) => ({
			value: String(index + 1),
			label: profileLabel(profile),
		}));
		const answer = options.onSelect
			? await options.onSelect({
					message: "Select a Kiro profile",
					options: optionsForSelect,
					defaultValue: "1",
				})
			: options.onPrompt
				? await options.onPrompt({
						message: `Select a Kiro profile:\n${optionsForSelect
							.map(option => `${option.value}. ${option.label}`)
							.join("\\n")}`,
						placeholder: "1",
					})
				: undefined;
		if (answer === undefined) throw new AIError.OnPromptRequiredError("Kiro profile selection");
		throwIfKiroLoginCancelled(signal);
		const index = Number.parseInt(answer.trim(), 10) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= profiles.length) {
			throw new AIError.OAuthError("Invalid Kiro profile selection", { kind: "validation", provider: PROVIDER });
		}
		selected = profiles[index]!;
	}
	return { profileArn: selected.arn, profileName: selected.profileName };
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
	return chooseKiroProfile(profiles, options.signal, options);
}

async function selectKiroProfileFromBootstrapRegions(
	token: string,
	options: KiroProfileSelectionOptions = {},
): Promise<{ profileArn: string; profileName: string | undefined }> {
	const profiles: KiroProfileSummary[] = [];
	let lastError: unknown;
	for (const apiRegion of KIRO_BOOTSTRAP_REGIONS) {
		try {
			profiles.push(
				...(await listKiroAvailableProfiles({
					apiRegion,
					token,
					fetch: options.fetch,
					signal: options.signal,
				})),
			);
		} catch (cause) {
			throwIfKiroLoginCancelled(options.signal);
			lastError = cause;
		}
	}
	const uniqueProfiles = [...new Map(profiles.map(profile => [profile.arn, profile])).values()];
	if (uniqueProfiles.length === 0 && lastError) {
		throw new AIError.OAuthError("Unable to discover Kiro profiles", {
			kind: "discovery",
			provider: PROVIDER,
			cause: lastError,
		});
	}
	return chooseKiroProfile(uniqueProfiles, options.signal, options);
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

function validateOidcEndpoint(value: unknown, region: string, field: string): string {
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
		parsed.pathname !== "/token" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return endpoint;
}

function validateVerificationUri(value: unknown, field: string): string {
	const uri = requiredString(value, field);
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch (cause) {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, {
			kind: "validation",
			provider: PROVIDER,
			cause,
		});
	}
	if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return uri;
}

function requiredUserCode(value: unknown): string {
	const userCode = requiredString(value, "userCode");
	if (userCode.length > 128 || /[\u0000-\u001f\u007f]/.test(userCode)) {
		throw new AIError.OAuthError("Kiro returned an invalid userCode", { kind: "validation", provider: PROVIDER });
	}
	return userCode;
}

interface KiroRegisteredClient {
	clientId: string;
	clientSecret: string;
	clientSecretExpiresAt: number;
	tokenEndpoint: string;
}

function parseRegisteredClient(body: unknown, region: string): KiroRegisteredClient {
	const registration = record(body, "Invalid Kiro client registration");
	return {
		clientId: requiredString(registration.clientId, "clientId"),
		clientSecret: requiredString(registration.clientSecret, "clientSecret"),
		clientSecretExpiresAt: registeredClientExpiry(registration.clientSecretExpiresAt),
		tokenEndpoint: validateOidcEndpoint(registration.tokenEndpoint, region, "tokenEndpoint"),
	};
}

function exactKiroScopes(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length === KIRO_IDENTITY_CENTER_SCOPES.length &&
		value.every((scope, index) => scope === KIRO_IDENTITY_CENTER_SCOPES[index])
	);
}

function registrationCacheKey(region: string): string {
	return `${KIRO_REGISTRATION_CACHE_PREFIX}${region}`;
}

function registrationIsUsable(client: KiroRegisteredClient): boolean {
	return (
		client.clientSecretExpiresAt === 0 ||
		client.clientSecretExpiresAt > Date.now() + KIRO_REGISTRATION_EXPIRY_MARGIN_MS
	);
}

function readCachedRegisteredClient(
	cache: OAuthLoginCache | undefined,
	region: string,
): KiroRegisteredClient | undefined {
	if (!cache) return undefined;
	let raw: string | null;
	try {
		raw = cache.get(registrationCacheKey(region));
	} catch {
		return undefined;
	}
	if (!raw) return undefined;
	try {
		const data = record(JSON.parse(raw), "Invalid cached Kiro client registration");
		if (
			data.registrationVersion !== KIRO_REGISTRATION_VERSION ||
			data.region !== region ||
			data.flow !== "device_code" ||
			data.clientName !== KIRO_CLIENT_NAME ||
			!exactKiroScopes(data.scopes)
		) {
			return undefined;
		}
		const expiresAt = data.clientSecretExpiresAt;
		if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0) return undefined;
		const client: KiroRegisteredClient = {
			clientId: requiredString(data.clientId, "clientId"),
			clientSecret: requiredString(data.clientSecret, "clientSecret"),
			clientSecretExpiresAt: expiresAt as number,
			tokenEndpoint: validateOidcEndpoint(data.tokenEndpoint, region, "tokenEndpoint"),
		};
		return registrationIsUsable(client) ? client : undefined;
	} catch {
		return undefined;
	}
}

function registrationCacheExpirySeconds(client: KiroRegisteredClient): number {
	const nowSeconds = Math.floor(Date.now() / 1000);
	if (client.clientSecretExpiresAt === 0) return nowSeconds + KIRO_CACHE_TTL_SECONDS;
	return Math.max(nowSeconds + 1, Math.floor(client.clientSecretExpiresAt / 1000));
}

function cacheRegisteredClient(cache: OAuthLoginCache | undefined, region: string, client: KiroRegisteredClient): void {
	if (!cache) return;
	try {
		cache.set(
			registrationCacheKey(region),
			JSON.stringify({
				registrationVersion: KIRO_REGISTRATION_VERSION,
				region,
				flow: "device_code",
				clientName: KIRO_CLIENT_NAME,
				scopes: KIRO_IDENTITY_CENTER_SCOPES,
				...client,
			}),
			registrationCacheExpirySeconds(client),
		);
	} catch {
		// Cache persistence is best-effort; the active login must still complete.
	}
}

async function registerKiroClient(ctrl: OAuthLoginCallbacks, region: string): Promise<KiroRegisteredClient> {
	const registered = await request(
		`https://oidc.${region}.amazonaws.com/client/register`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				clientName: KIRO_CLIENT_NAME,
				clientType: "public",
				scopes: KIRO_IDENTITY_CENTER_SCOPES,
			}),
		},
		{ fetch: ctrl.fetch, signal: ctrl.signal },
		"device-auth",
		"allow-non-json-error",
	);
	if (!registered.response.ok) {
		throw new AIError.OAuthError(`Kiro client registration failed: HTTP ${registered.response.status}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: registered.response.status,
		});
	}
	const client = parseRegisteredClient(registered.body, region);
	cacheRegisteredClient(ctrl.cache, region, client);
	return client;
}

async function getRegisteredClient(ctrl: OAuthLoginCallbacks, region: string): Promise<KiroRegisteredClient> {
	return readCachedRegisteredClient(ctrl.cache, region) ?? registerKiroClient(ctrl, region);
}

export interface KiroPromptDefaults {
	startUrl: string;
	region: string;
}

export function readKiroPromptDefaults(cache: OAuthLoginCache | undefined): KiroPromptDefaults | undefined {
	if (!cache) return undefined;
	let raw: string | null;
	try {
		raw = cache.get(KIRO_PROMPT_CACHE_KEY);
	} catch {
		return undefined;
	}
	if (!raw) return undefined;
	try {
		const data = record(JSON.parse(raw), "Invalid cached Kiro login defaults");
		const startUrl = validateStartUrl(requiredString(data.startUrl, "startUrl"));
		const region = validateKiroApiRegion(requiredString(data.region, "region"));
		return region ? { startUrl, region } : undefined;
	} catch {
		return undefined;
	}
}

function cachePromptDefaults(cache: OAuthLoginCache | undefined, defaults: KiroPromptDefaults): void {
	if (!cache) return;
	try {
		cache.set(
			KIRO_PROMPT_CACHE_KEY,
			JSON.stringify(defaults),
			Math.floor(Date.now() / 1000) + KIRO_CACHE_TTL_SECONDS,
		);
	} catch {
		// Prompt defaults are convenience state and must not block authentication.
	}
}

async function resolveDeviceInputs(
	ctrl: OAuthLoginCallbacks,
	config: KiroDeviceConfig,
): Promise<{ startUrl: string; region: string }> {
	const cached = readKiroPromptDefaults(ctrl.cache);
	const startUrlInput =
		config.startUrl ??
		(await ctrl.onPrompt({
			message: "Enter Start URL",
			...(cached?.startUrl ? { defaultValue: cached.startUrl } : {}),
		}));
	const startUrl = validateStartUrl((startUrlInput.trim() || cached?.startUrl || "").trim());

	const regionInput =
		config.region ??
		(await ctrl.onPrompt({
			message: "Enter Region",
			...(cached?.region ? { defaultValue: cached.region } : {}),
		}));
	const region = validateKiroApiRegion((regionInput.trim() || cached?.region || "").trim());
	if (!region) {
		throw new AIError.OAuthError("Invalid AWS Identity Center Region", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	const inputs = { startUrl, region };
	cachePromptDefaults(ctrl.cache, inputs);
	return inputs;
}

interface KiroDeviceAuthorization {
	client: KiroRegisteredClient;
	region: string;
	startUrl: string;
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
}

async function startDeviceAuthorization(
	ctrl: OAuthLoginCallbacks,
	client: KiroRegisteredClient,
	region: string,
	startUrl: string,
): Promise<KiroDeviceAuthorization> {
	const authorized = await request(
		`https://oidc.${region}.amazonaws.com/device_authorization`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, startUrl }),
		},
		{ fetch: ctrl.fetch, signal: ctrl.signal },
		"device-auth",
		"allow-non-json-error",
	);
	if (!authorized.response.ok) {
		throw new AIError.OAuthError(`Kiro device authorization failed: HTTP ${authorized.response.status}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: authorized.response.status,
		});
	}
	const device = record(authorized.body, "Invalid Kiro device authorization response");
	return {
		client,
		region,
		startUrl,
		deviceCode: requiredString(device.deviceCode, "deviceCode"),
		userCode: requiredUserCode(device.userCode),
		verificationUri: validateVerificationUri(device.verificationUri, "verificationUri"),
		verificationUriComplete: validateVerificationUri(device.verificationUriComplete, "verificationUriComplete"),
		expiresIn: positiveNumber(device.expiresIn, "expiresIn"),
		interval: positiveNumber(device.interval, "interval"),
	};
}

export async function loginKiroDevice(
	ctrl: OAuthLoginCallbacks,
	config: KiroDeviceConfig = {},
): Promise<OAuthCredentials> {
	const { startUrl, region } = await resolveDeviceInputs(ctrl, config);
	throwIfKiroLoginCancelled(ctrl.signal);
	const client = await getRegisteredClient(ctrl, region);
	const authorization = await startDeviceAuthorization(ctrl, client, region, startUrl);
	ctrl.onAuth({
		url: authorization.verificationUriComplete,
		userCode: authorization.userCode,
		expiresAt: Date.now() + authorization.expiresIn * 1000,
		instructions: "Confirm this code in the browser",
	});
	throwIfKiroLoginCancelled(ctrl.signal);
	ctrl.onProgress?.("Logging in...");
	const completed = await pollOAuthDeviceCodeFlow<OAuthCredentials>({
		poll: async () => {
			let polled: { response: Response; body: unknown };
			try {
				polled = await request(
					authorization.client.tokenEndpoint,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							clientId: authorization.client.clientId,
							clientSecret: authorization.client.clientSecret,
							deviceCode: authorization.deviceCode,
							grantType: DEVICE_CODE_GRANT,
						}),
					},
					{ fetch: ctrl.fetch, signal: ctrl.signal },
					"polling",
				);
			} catch (cause) {
				if (cause instanceof AIError.OAuthError && cause.kind === "timeout") {
					return { status: "pending" as const };
				}
				throw cause;
			}
			const pollBody = record(polled.body, "Invalid Kiro polling response");
			if (pollBody.error === "authorization_pending") return { status: "pending" as const };
			if (pollBody.error === "slow_down") return { status: "slow_down" as const };
			if (!polled.response.ok) {
				throw new AIError.OAuthError("Kiro device authorization rejected", {
					kind: "device-auth",
					provider: PROVIDER,
					status: polled.response.status,
				});
			}
			if (pollBody.error !== undefined) {
				throw new AIError.OAuthError("Kiro device authorization rejected", {
					kind: "device-auth",
					provider: PROVIDER,
					status: polled.response.status,
				});
			}
			return { status: "complete" as const, value: credentials(pollBody) };
		},
		intervalSeconds: authorization.interval,
		expiresInSeconds: authorization.expiresIn,
		waitBeforeFirstPoll: true,
		signal: ctrl.signal,
		sleep: ctrl.sleep,
	});
	throwIfKiroLoginCancelled(ctrl.signal);
	const selected = await selectKiroProfileFromBootstrapRegions(completed.access, {
		fetch: ctrl.fetch,
		signal: ctrl.signal,
		onPrompt: ctrl.onPrompt,
		onSelect: ctrl.onSelect,
	});
	throwIfKiroLoginCancelled(ctrl.signal);
	const parsedProfile = parseKiroProfileArn(selected.profileArn);
	if (!parsedProfile) {
		throw new AIError.OAuthError("Kiro profile routing is invalid", { kind: "validation", provider: PROVIDER });
	}
	return {
		...completed,
		apiEndpoint: kiroRuntimeBaseUrl(parsedProfile.apiRegion),
		kiroClientId: client.clientId,
		kiroClientSecret: client.clientSecret,
		kiroClientSecretExpiresAt: client.clientSecretExpiresAt,
		kiroTokenEndpoint: client.tokenEndpoint,
		kiroAuthMethod: "device",
		kiroRegistrationVersion: KIRO_REGISTRATION_VERSION,
		kiroStartUrl: startUrl,
		kiroOidcRegion: region,
		kiroScopes: [...KIRO_IDENTITY_CENTER_SCOPES],
		kiroAccountType: "iam-identity-center",
		kiroProfileArn: selected.profileArn,
		kiroRuntimeRegion: parsedProfile.apiRegion,
		orgId: selected.profileArn,
		orgName: selected.profileName,
	};
}

export async function refreshKiroToken(
	current: OAuthCredentials,
	options: KiroRequestOptions = {},
): Promise<OAuthCredentials> {
	if (current.expires > Date.now() + KIRO_REFRESH_MARGIN_MS) return current;
	if (current.kiroAuthMethod !== "device") {
		throw new AIError.OAuthError("Kiro refresh state is not an IAM Identity Center device credential", {
			kind: "configuration",
			provider: PROVIDER,
		});
	}
	if (!current.kiroTokenEndpoint || !current.kiroClientId || !current.kiroClientSecret) {
		throw new AIError.OAuthError("Kiro refresh state is incomplete", { kind: "configuration", provider: PROVIDER });
	}
	if (!current.refresh) {
		throw new AIError.OAuthError("Kiro refresh requires a refresh token", {
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
		parsed = new URL(current.kiroTokenEndpoint);
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
	if (current.kiroOidcRegion && parsed.hostname !== `oidc.${current.kiroOidcRegion}.amazonaws.com`) {
		throw new AIError.OAuthError("Kiro refresh endpoint does not match the credential Region", {
			kind: "configuration",
			provider: PROVIDER,
		});
	}
	const response = await request(
		current.kiroTokenEndpoint,
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
		...current,
		...credentials(response.body, current.refresh),
		kiroClientId: current.kiroClientId,
		kiroClientSecret: current.kiroClientSecret,
		kiroClientSecretExpiresAt: current.kiroClientSecretExpiresAt,
		kiroTokenEndpoint: current.kiroTokenEndpoint,
		kiroAuthMethod: "device",
	};
}

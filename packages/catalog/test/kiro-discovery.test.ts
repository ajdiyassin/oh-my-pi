import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	fetchKiroModels,
	kiroManagementRequest,
	mapKiroModelCatalog,
	probeKiroApiKeyBootstrap,
	resolveKiroDiscoveryRoute,
	type SanitizedJsonSchema,
	type SanitizedKiroModelCatalog,
	sanitizeKiroModelCatalog,
} from "../src/discovery/kiro";
import { resolveProviderModels } from "../src/model-manager";
import {
	KIRO_LEGACY_MODEL_ALIASES,
	KIRO_MODEL_CACHE_TTL_MS,
	kiroModelManagerOptions,
	resolveKiroModelAlias,
} from "../src/provider-models/kiro";
import {
	extractRegionFromKiroEndpoint,
	extractRegionFromKiroProfileArn,
	KIRO_BOOTSTRAP_REGIONS,
	kiroManagementBaseUrl,
	kiroRuntimeBaseUrl,
	parseKiroEndpoint,
	parseKiroProfileArn,
	validateKiroApiRegion,
} from "../src/wire/kiro";

const RUNTIME_US = "https://runtime.us-east-1.kiro.dev/";

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/x-amz-json-1.0" },
	});
}

function claudeAdaptiveModel(overrides: Record<string, unknown> = {}) {
	return {
		modelId: "claude-sonnet-5",
		modelName: "claude-sonnet-5",
		supportedInputTypes: ["TEXT", "IMAGE"],
		tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
		promptCaching: {
			supportsPromptCaching: true,
			maximumCacheCheckpointsPerRequest: 4,
			minimumTokensPerCacheCheckpoint: 1024,
		},
		additionalModelRequestFieldsSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				thinking: {
					type: "object",
					required: ["type"],
					properties: {
						type: { type: "string", enum: ["adaptive", "disabled"] },
						display: { type: "string", enum: ["summarized", "omitted"] },
					},
				},
				output_config: {
					type: "object",
					properties: {
						effort: {
							type: "string",
							default: "high",
							enum: ["low", "medium", "high", "xhigh", "max"],
						},
					},
				},
				max_tokens: { type: "integer", minimum: 1024, maximum: 128_000 },
			},
		},
		rateMultiplier: 1.3,
		rateUnit: "Credit",
		...overrides,
	};
}

function gptReasoningModel(overrides: Record<string, unknown> = {}) {
	return {
		modelId: "gpt-5.6-sol",
		modelName: "gpt-5.6-sol",
		supportedInputTypes: ["TEXT", "IMAGE"],
		tokenLimits: { maxInputTokens: 272_000, maxOutputTokens: 128_000 },
		additionalModelRequestFieldsSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				reasoning: {
					type: "object",
					properties: {
						mode: { type: "string", default: "standard", enum: ["standard", "pro"] },
						effort: {
							type: "string",
							default: "high",
							enum: ["none", "low", "medium", "high", "xhigh", "max"],
						},
					},
				},
			},
		},
		rateMultiplier: 2.4,
		rateUnit: "Credit",
		...overrides,
	};
}

function autoModel(overrides: Record<string, unknown> = {}) {
	return {
		modelId: "auto",
		modelName: "auto",
		supportedInputTypes: ["TEXT", "IMAGE"],
		tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
		rateMultiplier: 1,
		rateUnit: "Credit",
		...overrides,
	};
}

function sampleCatalog(models: Record<string, unknown>[] = [autoModel(), claudeAdaptiveModel(), gptReasoningModel()]) {
	return {
		defaultModel: { modelId: "auto" },
		models,
		// Additive unknown top-level key must be tolerated by the native sanitizer.
		futureCatalogHint: { ignored: true },
	};
}

const tempDirs = new Set<string>();

afterEach(async () => {
	for (const dir of tempDirs) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
	tempDirs.clear();
});

async function tempCacheDb(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-catalog-"));
	tempDirs.add(dir);
	return path.join(dir, "models.db");
}

describe("Kiro route and profile helpers", () => {
	it("validates regions and constructs only management/runtime endpoints", () => {
		expect(validateKiroApiRegion("us-east-1")).toBe("us-east-1");
		expect(validateKiroApiRegion("ca-central-1")).toBe("ca-central-1");
		expect(kiroManagementBaseUrl("eu-central-1")).toBe("https://management.eu-central-1.kiro.dev/");
		expect(kiroRuntimeBaseUrl("us-east-1")).toBe(RUNTIME_US);
		expect(KIRO_BOOTSTRAP_REGIONS).toEqual(["us-east-1", "eu-central-1"]);
	});

	it("rejects SSRF-shaped regions and endpoints", () => {
		expect(validateKiroApiRegion("us-east-1.evil.com")).toBeUndefined();
		expect(validateKiroApiRegion("us-east-1/../admin")).toBeUndefined();
		expect(validateKiroApiRegion("http://evil")).toBeUndefined();
		expect(parseKiroEndpoint("https://evil.com/")).toBeUndefined();
		expect(parseKiroEndpoint("https://user:pass@runtime.us-east-1.kiro.dev/")).toBeUndefined();
		expect(parseKiroEndpoint("http://runtime.us-east-1.kiro.dev/")).toBeUndefined();
		expect(parseKiroEndpoint("https://runtime.us-east-1.kiro.dev.evil.com/")).toBeUndefined();
		expect(parseKiroEndpoint("https://runtime.us-east-1.kiro.dev/extra")).toBeUndefined();
		expect(parseKiroEndpoint("https://runtime.us-east-1.kiro.dev/?x=1")).toBeUndefined();
		expect(() => kiroManagementBaseUrl("us-east-1.evil.com")).toThrow("Invalid Kiro API region");
	});

	it("parses exact profile ARNs and rejects malformed ones", () => {
		const arn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example";
		expect(parseKiroProfileArn(arn)).toEqual({ apiRegion: "eu-central-1", profileArn: arn });
		expect(extractRegionFromKiroProfileArn(arn)).toBe("eu-central-1");
		expect(parseKiroProfileArn("arn:evil:codewhisperer:eu-central-1:123:profile/x")).toBeUndefined();
		expect(parseKiroProfileArn("arn:aws:codewhisperer:eu-central-1.evil:123:profile/x")).toBeUndefined();
		expect(extractRegionFromKiroEndpoint(RUNTIME_US)).toBe("us-east-1");
	});
});

describe("Kiro sanitizer and schema-derived mapping", () => {
	it("maps Claude adaptive and GPT reasoning literals with exact dotted IDs", () => {
		const sanitized = sanitizeKiroModelCatalog(sampleCatalog());
		const models = mapKiroModelCatalog(sanitized, RUNTIME_US);
		expect(models.map(model => model.id)).toEqual(["auto", "claude-sonnet-5", "gpt-5.6-sol"]);
		expect(models.map(model => model.id)).not.toContain("gpt-5-6-sol");

		const claude = models.find(model => model.id === "claude-sonnet-5");
		expect(claude).toMatchObject({
			api: "kiro-api",
			provider: "kiro",
			baseUrl: RUNTIME_US,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			premiumMultiplier: 1.3,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: ["low", "medium", "high", "xhigh", "max"],
				defaultLevel: "high",
				effortMap: { minimal: "low" },
				supportsDisplay: true,
			},
			kiroPromptCaching: {
				supportsPromptCaching: true,
				maximumCacheCheckpointsPerRequest: 4,
				minimumTokensPerCacheCheckpoint: 1024,
			},
		});

		const gpt = models.find(model => model.id === "gpt-5.6-sol");
		expect(gpt).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272_000,
			maxTokens: 128_000,
			premiumMultiplier: 2.4,
			thinking: {
				mode: "effort",
				efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
				defaultLevel: "high",
				effortMap: { minimal: "none" },
			},
		});

		const auto = models.find(model => model.id === "auto");
		expect(auto?.reasoning).toBe(false);
		expect(auto?.thinking).toBeUndefined();
	});

	it("tolerates unknown additive model keys while validating recognized fields", () => {
		const catalog = sampleCatalog([
			{
				...gptReasoningModel(),
				vendorExperimental: { flag: true },
			},
		]);
		catalog.defaultModel = { modelId: "gpt-5.6-sol" };
		expect(sanitizeKiroModelCatalog(catalog).models).toHaveLength(1);
	});

	it("fails closed on empty, oversized, and malformed responses", () => {
		expect(() => sanitizeKiroModelCatalog({ defaultModel: { modelId: "auto" }, models: [] })).toThrow("models.count");
		expect(() =>
			sanitizeKiroModelCatalog({
				defaultModel: { modelId: "m0" },
				models: Array.from({ length: 129 }, (_, i) => ({
					modelId: `m${i}`,
					modelName: `m${i}`,
					supportedInputTypes: ["TEXT"],
					tokenLimits: { maxInputTokens: 1, maxOutputTokens: 1 },
				})),
			}),
		).toThrow("models.count");
		expect(() => sanitizeKiroModelCatalog(null)).toThrow("top-level.object");
		expect(() =>
			sanitizeKiroModelCatalog({
				defaultModel: { modelId: "x" },
				models: [
					{
						modelId: "x",
						modelName: "x",
						supportedInputTypes: ["TEXT"],
						tokenLimits: { maxInputTokens: 0, maxOutputTokens: 1 },
					},
				],
			}),
		).toThrow("model.max-input");
	});

	it("rejects malformed recognized schemas and unknown request-schema families", () => {
		const unknownFamily = sanitizeKiroModelCatalog(
			sampleCatalog([
				autoModel({
					additionalModelRequestFieldsSchema: {
						type: "object",
						properties: { future_reasoning: { type: "boolean" } },
					},
				}),
			]),
		);
		expect(() => mapKiroModelCatalog(unknownFamily, RUNTIME_US)).toThrow("unknown-family");

		const badDefault = structuredClone(sanitizeKiroModelCatalog(sampleCatalog())) as SanitizedKiroModelCatalog;
		const effort = badDefault.models.find(model => model.modelId === "claude-sonnet-5")
			?.additionalModelRequestFieldsSchema?.properties?.output_config?.properties?.effort;
		if (!effort) throw new Error("missing effort schema");
		effort.default = "unsupported";
		expect(() => mapKiroModelCatalog(badDefault, RUNTIME_US)).toThrow("anthropic.default");

		const extraKeyword = structuredClone(sanitizeKiroModelCatalog(sampleCatalog())) as SanitizedKiroModelCatalog;
		const gptRoot = extraKeyword.models.find(model => model.modelId === "gpt-5.6-sol")
			?.additionalModelRequestFieldsSchema as SanitizedJsonSchema & { anyOf?: unknown[] };
		if (!gptRoot) throw new Error("missing gpt schema");
		gptRoot.anyOf = [];
		expect(() => mapKiroModelCatalog(extraKeyword, RUNTIME_US)).toThrow("gpt.root");
	});
});

describe("Kiro management client", () => {
	it("probes API-key bootstrap regions with exact targets and bodies", async () => {
		const calls: Array<{ url: string; target: string | null; body: unknown }> = [];
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				calls.push({
					url,
					target: headers.get("X-Amz-Target"),
					body: JSON.parse(String(init?.body)),
				});
				if (url.includes("eu-central-1")) {
					return jsonResponse({ message: "forbidden" }, 403);
				}
				return jsonResponse(sampleCatalog());
			},
			{ preconnect() {} },
		);

		const probed = await probeKiroApiKeyBootstrap({ token: "ksk_test", fetch: fetchImpl });
		expect(probed?.route.apiRegion).toBe("us-east-1");
		expect(calls).toHaveLength(2);
		expect(calls.map(call => call.url)).toEqual([
			"https://management.us-east-1.kiro.dev/",
			"https://management.eu-central-1.kiro.dev/",
		]);
		for (const call of calls) {
			expect(call.target).toBe("AmazonCodeWhispererService.ListAvailableModels");
			expect(call.body).toEqual({ origin: "KIRO_CLI" });
		}

		const models = await fetchKiroModels({
			credential: { type: "api_key", token: "ksk_test" },
			fetch: fetchImpl,
		});
		expect(models?.some(model => model.id === "gpt-5.6-sol")).toBe(true);
	});

	it("uses the OAuth profile route and request body", async () => {
		const profileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example";
		let captured: { url: string; body: unknown; target: string | null } | undefined;
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				captured = {
					url: String(input),
					body: JSON.parse(String(init?.body)),
					target: headers.get("X-Amz-Target"),
				};
				return jsonResponse(sampleCatalog());
			},
			{ preconnect() {} },
		);

		expect(resolveKiroDiscoveryRoute({ type: "oauth", token: "access", profileArn })).toMatchObject({
			apiRegion: "eu-central-1",
			profileArn,
			runtimeBaseUrl: "https://runtime.eu-central-1.kiro.dev/",
		});

		const models = await fetchKiroModels({
			credential: { type: "oauth", token: "access", profileArn },
			fetch: fetchImpl,
		});
		expect(models?.[0]?.baseUrl).toBe("https://runtime.eu-central-1.kiro.dev/");
		expect(captured).toEqual({
			url: "https://management.eu-central-1.kiro.dev/",
			target: "AmazonCodeWhispererService.ListAvailableModels",
			body: { origin: "KIRO_CLI", profileArn },
		});
	});

	it("rejects oversized management response bodies", async () => {
		const fetchImpl: typeof fetch = Object.assign(
			async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
			{ preconnect() {} },
		);
		await expect(
			kiroManagementRequest({
				apiRegion: "us-east-1",
				token: "ksk_test",
				target: "ListAvailableModels",
				body: { origin: "KIRO_CLI" },
				fetch: fetchImpl,
			}),
		).rejects.toThrow("invalid response size");
	});
});

describe("kiroModelManagerOptions and aliases", () => {
	it("configures providerId, authoritative discovery, 24h TTL, and no static models", () => {
		const options = kiroModelManagerOptions();
		expect(options.providerId).toBe("kiro");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.cacheTtlMs).toBe(KIRO_MODEL_CACHE_TTL_MS);
		expect(options.cacheTtlMs).toBe(24 * 60 * 60 * 1000);
		expect(options.staticModels).toEqual([]);
	});

	it("returns null when auth is unavailable", async () => {
		const options = kiroModelManagerOptions({
			resolveCredential: async () => undefined,
		});
		await expect(options.fetchDynamicModels?.()).resolves.toBeNull();
	});

	it("applies only exact historical aliases", () => {
		expect(resolveKiroModelAlias("claude-opus-4-8")).toBe("claude-opus-4.8");
		expect(resolveKiroModelAlias("claude-sonnet-4-5")).toBe("claude-sonnet-4.5");
		expect(resolveKiroModelAlias("minimax-m2-1")).toBe("minimax-m2.1");
		expect(resolveKiroModelAlias("gpt-5.6-sol")).toBe("gpt-5.6-sol");
		expect(resolveKiroModelAlias("future.model-7.2")).toBe("future.model-7.2");
		expect(Object.keys(KIRO_LEGACY_MODEL_ALIASES)).toHaveLength(9);
	});
});

describe("Kiro cache behavior through resolveProviderModels", () => {
	it("authoritatively replaces, reuses fresh cache, retains stale after failure, stays identity-free, and keeps auto only from live/cache", async () => {
		const cacheDbPath = await tempCacheDb();
		let nowMs = 1_000_000;
		let liveCatalog = sampleCatalog();
		let shouldFail = false;
		let fetchCount = 0;

		const fetchImpl: typeof fetch = Object.assign(
			async () => {
				fetchCount += 1;
				if (shouldFail) return jsonResponse({ message: "unavailable" }, 503);
				return jsonResponse(liveCatalog);
			},
			{ preconnect() {} },
		);

		const options = kiroModelManagerOptions({
			cacheDbPath,
			now: () => nowMs,
			fetch: fetchImpl,
			resolveCredential: async () => ({
				type: "api_key",
				token: "ksk_test",
				apiEndpoint: RUNTIME_US,
			}),
		});

		const first = await resolveProviderModels(options, "online");
		expect(first.stale).toBe(false);
		expect(first.models.map(model => model.id).sort()).toEqual(["auto", "claude-sonnet-5", "gpt-5.6-sol"]);
		expect(fetchCount).toBe(1);

		const reused = await resolveProviderModels(options, "online-if-uncached");
		expect(reused.models.map(model => model.id).sort()).toEqual(["auto", "claude-sonnet-5", "gpt-5.6-sol"]);
		expect(fetchCount).toBe(1);

		liveCatalog = {
			defaultModel: { modelId: "gpt-5.6-sol" },
			models: [gptReasoningModel(), autoModel()],
			futureCatalogHint: { ignored: true },
		};
		nowMs += KIRO_MODEL_CACHE_TTL_MS + 1;
		const replaced = await resolveProviderModels(options, "online");
		expect(replaced.models.map(model => model.id).sort()).toEqual(["auto", "gpt-5.6-sol"]);
		expect(replaced.models.some(model => model.id === "claude-sonnet-5")).toBe(false);
		expect(fetchCount).toBe(2);

		shouldFail = true;
		nowMs += KIRO_MODEL_CACHE_TTL_MS + 1;
		const stale = await resolveProviderModels(options, "online");
		expect(stale.stale).toBe(true);
		expect(stale.models.map(model => model.id).sort()).toEqual(["auto", "gpt-5.6-sol"]);
		expect(fetchCount).toBe(3);

		const db = new Database(cacheDbPath, { readonly: true });
		const row = db.query("SELECT models FROM model_cache WHERE provider_id = ?").get("kiro") as {
			models: string;
		} | null;
		db.close();
		expect(row?.models).toBeString();
		const persisted = row!.models;
		expect(persisted).not.toMatch(/arn:aws:codewhisperer/i);
		expect(persisted).not.toMatch(/ksk_/i);
		expect(persisted).not.toMatch(/Bearer\s+/i);
		expect(persisted).not.toMatch(/profileArn/i);
		expect(persisted).not.toMatch(/@/);
		expect(persisted).toContain('"id":"auto"');

		const cold = await resolveProviderModels(
			kiroModelManagerOptions({
				cacheDbPath: await tempCacheDb(),
				now: () => nowMs,
				resolveCredential: async () => undefined,
			}),
			"online",
		);
		expect(cold.models).toEqual([]);
		expect(cold.models.some(model => model.id === "auto")).toBe(false);
	});
});

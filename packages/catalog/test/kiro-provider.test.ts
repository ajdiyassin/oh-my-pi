import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
	resolveKiroModelCacheProviderId,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models";
import { kiroModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/kiro-default";
const API_ENDPOINT = "https://management.us-east-1.kiro.dev/";

function catalogResponse(modelIds: readonly string[]): Record<string, unknown> {
	return {
		defaultModel: modelIds[0],
		models: modelIds.map(modelId => ({
			modelId,
			modelName: modelId,
			supportedInputModalities: ["TEXT"],
			supportedOutputModalities: ["TEXT"],
			tokenLimits: { maxInputTokens: 100_000, maxOutputTokens: 8_192 },
		})),
	};
}

function jsonFetch(payload: unknown, status = 200): FetchImpl {
	return async () =>
		new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function fallbackSpec(): ModelSpec<"kiro-api"> {
	return {
		id: "bundled-fallback",
		name: "Bundled fallback",
		api: "kiro-api",
		provider: "kiro",
		baseUrl: API_ENDPOINT,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 50_000,
		maxTokens: 4_096,
	};
}

describe("Kiro provider discovery", () => {
	test("is authoritative, explicit-only, and has no automatic default", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "kiro");

		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBeUndefined();
		expect(descriptor?.requiresExplicitModelSelection).toBe(true);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER).not.toHaveProperty("kiro");
	});

	test("sends the selected OAuth profile ARN in the ListAvailableModels body", async () => {
		let requestBody: unknown;
		const fetch: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return Response.json(catalogResponse(["kiro-oauth-model"]));
		};
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "oauth-bearer", profileArn: PROFILE_ARN }),
			fetch,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["kiro-oauth-model"]);
		expect(requestBody).toEqual({ origin: "KIRO_CLI", profileArn: PROFILE_ARN });
	});

	test("uses a credential-scoped cache namespace without raw credential identity", () => {
		const token = "kiro-api-key-with-sensitive-value";
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token, apiEndpoint: API_ENDPOINT }),
		});
		const namespace = options.cacheProviderId ?? "";

		expect(namespace).toMatch(/^kiro:models-v1:/);
		expect(namespace).not.toContain(token);
		expect(namespace).not.toContain(PROFILE_ARN);
	});

	test("keeps cache identity profile-scoped and agrees with the lightweight resolver", () => {
		const oauthProfileA = JSON.stringify({ token: "rotated-access-a", profileArn: PROFILE_ARN });
		const oauthProfileARotated = JSON.stringify({ token: "new-access-a", profileArn: PROFILE_ARN });
		const oauthProfileB = JSON.stringify({
			token: "rotated-access-b",
			profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/other",
		});
		const apiKeyEndpointA = JSON.stringify({ token: "api-key-a", apiEndpoint: API_ENDPOINT });
		const apiKeyEndpointB = JSON.stringify({
			token: "api-key-a",
			apiEndpoint: "https://management.eu-west-1.kiro.dev/",
		});

		expect(resolveKiroModelCacheProviderId(oauthProfileA)).toBe(
			resolveKiroModelCacheProviderId(oauthProfileARotated),
		);
		expect(resolveKiroModelCacheProviderId(oauthProfileA)).not.toBe(resolveKiroModelCacheProviderId(oauthProfileB));
		expect(resolveKiroModelCacheProviderId(apiKeyEndpointA)).not.toBe(
			resolveKiroModelCacheProviderId(apiKeyEndpointB),
		);
		expect(resolveModelCacheProviderId("kiro", { apiKey: oauthProfileA })).toBe(
			resolveKiroModelCacheProviderId(oauthProfileA),
		);
		expect(resolveModelCacheProviderId("kiro")).toBe("kiro");
		expect(resolveKiroModelCacheProviderId(oauthProfileA)).not.toContain(PROFILE_ARN);
		expect(resolveKiroModelCacheProviderId(oauthProfileA)).not.toContain("rotated-access-a");
	});

	test("prunes static fallback models after a successful live catalog refresh", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-kiro-live-"));
		try {
			const options = kiroModelManagerOptions({
				apiKey: JSON.stringify({ token: "live-token", apiEndpoint: API_ENDPOINT }),
				fetch: jsonFetch(catalogResponse(["kiro-live-model"])),
			});
			const result = await resolveProviderModels(
				{
					...options,
					staticModels: [fallbackSpec()],
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);

			expect(result.stale).toBe(false);
			expect(result.models.map(model => model.id)).toEqual(["kiro-live-model"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("retains cached live models and reports stale after discovery failure", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-kiro-failure-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		try {
			const credential = JSON.stringify({ token: "cached-token", apiEndpoint: API_ENDPOINT });
			const online = kiroModelManagerOptions({
				apiKey: credential,
				fetch: jsonFetch(catalogResponse(["kiro-cached-model"])),
			});
			const populated = await resolveProviderModels(
				{ ...online, staticModels: [fallbackSpec()], cacheDbPath },
				"online",
			);
			expect(populated.models.map(model => model.id)).toEqual(["kiro-cached-model"]);

			const failed = kiroModelManagerOptions({
				apiKey: credential,
				fetch: jsonFetch({}, 503),
			});
			const result = await resolveProviderModels(
				{ ...failed, staticModels: [fallbackSpec()], cacheDbPath },
				"online",
			);

			expect(result.stale).toBe(true);
			expect(result.models.some(model => model.id === "kiro-cached-model")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

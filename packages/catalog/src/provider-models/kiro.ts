/**
 * Kiro special model-manager options and exact historical selector aliases.
 * Discovery credentials are injected by the caller; this module never reads AuthStorage.
 */
import { fetchKiroModels, type KiroDiscoveryCredential } from "../discovery/kiro";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";

/** Explicit 24h TTL matching prior extension behavior for the unofficial management API. */
export const KIRO_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Explicit compatibility for selectors emitted by pre-dynamic releases.
 * Never infer version punctuation: IDs such as `gpt-5.6-sol` pass through unchanged.
 */
export const KIRO_LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	"claude-opus-4-8": "claude-opus-4.8",
	"claude-opus-4-7": "claude-opus-4.7",
	"claude-opus-4-6": "claude-opus-4.6",
	"claude-sonnet-4-6": "claude-sonnet-4.6",
	"claude-sonnet-4-5": "claude-sonnet-4.5",
	"claude-haiku-4-5": "claude-haiku-4.5",
	"deepseek-3-2": "deepseek-3.2",
	"minimax-m2-5": "minimax-m2.5",
	"minimax-m2-1": "minimax-m2.1",
});

/** Resolve only the exact historical alias table; unknown ids pass through. */
export function resolveKiroModelAlias(modelId: string): string {
	return KIRO_LEGACY_MODEL_ALIASES[modelId] ?? modelId;
}

export interface KiroModelManagerConfig {
	/** Lazy resolver for the active discovery credential. */
	resolveCredential?: () => Promise<KiroDiscoveryCredential | undefined | null>;
	fetch?: FetchImpl;
	cacheDbPath?: string;
	now?: () => number;
}

/**
 * Authoritative Kiro catalog manager options. No static models; unavailable auth
 * or failed discovery returns `null` so OMP retains the last safe cache.
 */
export function kiroModelManagerOptions(config: KiroModelManagerConfig = {}): ModelManagerOptions<"kiro-api"> {
	const { resolveCredential, fetch: fetchImpl, cacheDbPath, now } = config;
	return {
		providerId: "kiro",
		staticModels: [],
		dynamicModelsAuthoritative: true,
		cacheTtlMs: KIRO_MODEL_CACHE_TTL_MS,
		...(cacheDbPath ? { cacheDbPath } : {}),
		...(now ? { now } : {}),
		fetchDynamicModels: async () => {
			if (!resolveCredential) return null;
			const credential = await resolveCredential();
			if (!credential) return null;
			return fetchKiroModels({ credential, fetch: fetchImpl });
		},
	};
}

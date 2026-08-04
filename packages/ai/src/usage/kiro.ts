import { kiroManagementRequest } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { parseKiroProfileArn } from "@oh-my-pi/pi-catalog/wire/kiro";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageUnit,
} from "../usage";
import { isRecord } from "../utils";

/**
 * Kiro quota usage.
 *
 * Capture-verified contract: `GetUsageLimits` on the current
 * `KiroControlPlaneBearerService` target, authenticated with a refreshed OAuth
 * bearer token and the selected profile ARN. The response carries one
 * `usageBreakdownList` entry per metered resource, each with credit-denominated
 * usage plus optional overage/bonus metadata.
 *
 * API-key credentials are unsupported: the observed contract is profile-scoped,
 * and no capture proves an API-key-authenticated usage route.
 */

const MAX_USAGE_RESPONSE_BYTES = 128 * 1024;
const MAX_BREAKDOWN_ENTRIES = 32;

/** Epoch-seconds reset stamps observed in captures; tolerate millisecond stamps. */
const MAX_EPOCH_SECONDS = 1e11;

function resetMillis(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined || parsed <= 0) return undefined;
	return parsed < MAX_EPOCH_SECONDS ? Math.round(parsed * 1000) : Math.round(parsed);
}

/** Prefer the `*WithPrecision` sibling when present; both are reported per bucket. */
function preciseNumber(entry: Record<string, unknown>, base: string): number | undefined {
	return toNumber(entry[`${base}WithPrecision`]) ?? toNumber(entry[base]);
}

function usageStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

/**
 * Kiro meters in credits and requests; neither maps onto a token/usd unit, so
 * request-denominated resources report `requests` and everything else falls back
 * to `unknown` rather than misreporting a unit the provider never stated.
 */
function usageUnit(resourceType: string | undefined): UsageUnit {
	return resourceType?.includes("REQUEST") ? "requests" : "unknown";
}

function buildAmount(used: number | undefined, limit: number | undefined, unit: UsageUnit): UsageAmount {
	const usedFraction = used !== undefined && limit !== undefined && limit > 0 ? Math.min(used / limit, 1) : undefined;
	return {
		used,
		limit,
		remaining: used !== undefined && limit !== undefined ? Math.max(limit - used, 0) : undefined,
		usedFraction,
		remainingFraction: usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined,
		unit,
	};
}

function boundedLabel(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 128 ? value.trim() : fallback;
}

/**
 * Overage/bonus notes are emitted only from values the response actually
 * reported, so a display layer never shows an inferred billing figure.
 */
function buildNotes(entry: Record<string, unknown>, overageStatus: string | undefined): string[] {
	const notes: string[] = [];
	const unitLabel = boundedLabel(entry.displayNamePlural, boundedLabel(entry.displayName, "credits"));

	const overages = preciseNumber(entry, "currentOverages");
	const overageCap = preciseNumber(entry, "overageCap");
	if (overages !== undefined && overages > 0) {
		notes.push(overageCap !== undefined ? `overage ${overages} / ${overageCap}` : `overage ${overages}`);
	}

	const charges = toNumber(entry.overageCharges);
	if (charges !== undefined && charges > 0) {
		const currency = boundedLabel(entry.currency, "");
		notes.push(currency ? `overage charges ${charges} ${currency}` : `overage charges ${charges}`);
	}

	const rate = toNumber(entry.overageRate);
	if (rate !== undefined && rate > 0) notes.push(`overage rate ${rate}/${unitLabel}`);

	// `overageStatus` is already `OVERAGE_*`; normalize in place rather than re-prefixing.
	if (overageStatus) notes.push(overageStatus.toLowerCase().replace(/_/g, " "));

	if (Array.isArray(entry.bonuses) && entry.bonuses.length > 0) {
		notes.push(`${entry.bonuses.length} bonus grant${entry.bonuses.length === 1 ? "" : "s"}`);
	}
	if (Array.isArray(entry.overageCredits) && entry.overageCredits.length > 0) {
		notes.push(`${entry.overageCredits.length} overage credit${entry.overageCredits.length === 1 ? "" : "s"}`);
	}
	return notes;
}

function buildLimit(
	entry: Record<string, unknown>,
	index: number,
	params: UsageFetchParams,
	profileSegment: string,
	fallbackReset: number | undefined,
	overageStatus: string | undefined,
	planTitle: string | undefined,
): UsageLimit | null {
	const used = preciseNumber(entry, "currentUsage");
	const limit = preciseNumber(entry, "usageLimit");
	if (used === undefined && limit === undefined) return null;

	const resourceType = typeof entry.resourceType === "string" ? entry.resourceType : undefined;
	const unit = usageUnit(resourceType);
	const amount = buildAmount(used, limit, unit);
	const id = resourceType?.toLowerCase() ?? `resource-${index}`;
	const resetsAt = resetMillis(entry.nextDateReset) ?? fallbackReset;
	const notes = buildNotes(entry, overageStatus);
	const status = usageStatus(amount.usedFraction);

	return {
		id,
		label: boundedLabel(entry.displayNamePlural, boundedLabel(entry.displayName, resourceType ?? "Usage")),
		scope: {
			provider: params.provider,
			// The selected profile is the quota scope, reduced to its trailing segment.
			orgId: profileSegment,
			...(planTitle ? { tier: planTitle } : {}),
		},
		window: {
			id: "monthly",
			label: "Monthly",
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
		amount,
		...(status ? { status } : {}),
		...(notes.length > 0 ? { notes } : {}),
	};
}

async function fetchKiroUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const token = params.credential.accessToken;
	if (params.credential.type !== "oauth" || !token) return null;

	// `orgId` holds the profile ARN selected at login and preserved across refresh.
	const parsed = parseKiroProfileArn(params.credential.orgId);
	if (!parsed) {
		ctx.logger?.debug("Kiro usage skipped: no validated profile", { provider: params.provider });
		return null;
	}

	const payload = await kiroManagementRequest({
		apiRegion: parsed.apiRegion,
		token,
		service: "KiroControlPlaneBearerService",
		target: "GetUsageLimits",
		body: { origin: "KIRO_CLI", profileArn: parsed.profileArn },
		fetch: ctx.fetch,
		signal: params.signal,
		maxBytes: MAX_USAGE_RESPONSE_BYTES,
	});
	if (!isRecord(payload)) return null;

	const breakdown = payload.usageBreakdownList;
	if (!Array.isArray(breakdown) || breakdown.length === 0 || breakdown.length > MAX_BREAKDOWN_ENTRIES) {
		ctx.logger?.debug("Kiro usage response had no usable breakdown", { provider: params.provider });
		return null;
	}

	const subscription = isRecord(payload.subscriptionInfo) ? payload.subscriptionInfo : undefined;
	const planTitle = subscription ? boundedLabel(subscription.subscriptionTitle, "") || undefined : undefined;
	const overageConfiguration = isRecord(payload.overageConfiguration) ? payload.overageConfiguration : undefined;
	const overageStatus =
		overageConfiguration && typeof overageConfiguration.overageStatus === "string"
			? overageConfiguration.overageStatus
			: undefined;
	const fallbackReset = resetMillis(payload.nextDateReset);
	// Display-safe quota identity. The full ARN embeds the AWS account id and
	// never leaves this function.
	const profileSegment = parsed.profileArn.slice(parsed.profileArn.lastIndexOf("/") + 1);

	const limits = breakdown
		.map((entry, index) =>
			isRecord(entry)
				? buildLimit(entry, index, params, profileSegment, fallbackReset, overageStatus, planTitle)
				: null,
		)
		.filter((limit): limit is UsageLimit => limit !== null);
	if (limits.length === 0) return null;

	// `raw` is intentionally omitted: the upstream payload carries account/user
	// identifiers that must stay out of reports and diagnostics.
	//
	// `metadata.orgId` is stamped explicitly with the same trailing profile
	// segment the limits expose. Leaving metadata unset would let
	// `AuthStorage.#fetchUsageUncached` backfill it from `credential.orgId` —
	// the full profile ARN, including the AWS account id — which `omp usage`
	// then prints in the account header and emits in `--json`.
	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { orgId: profileSegment },
	};
}

export const kiroUsageProvider: UsageProvider = {
	id: "kiro",
	fetchUsage: fetchKiroUsage,
	validatesCredentials: true,
	supports: params =>
		params.provider === "kiro" &&
		params.credential.type === "oauth" &&
		Boolean(params.credential.accessToken) &&
		parseKiroProfileArn(params.credential.orgId) !== undefined,
};

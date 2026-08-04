import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import type { SlashCommandRuntime } from "../types";
import { reportMatchesActiveAccount } from "./active-oauth-account";
import { formatDuration, renderAsciiBar } from "./format";

function sanitizeUsageLine(value: string): string {
	return sanitizeText(value.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "));
}

function sanitizeOptionalUsageLine(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const sanitized = sanitizeUsageLine(value);
	return sanitized.length > 0 ? sanitized : undefined;
}

function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function formatWindowSuffix(label: string, windowLabel: string | undefined): string {
	const safeWindowLabel = sanitizeOptionalUsageLine(windowLabel);
	if (!safeWindowLabel) return "";
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = safeWindowLabel.toLowerCase();
	if (normalizedWindow === "quota window" || normalizedLabel.includes(normalizedWindow)) return "";
	return ` — ${safeWindowLabel}`;
}

function formatUsageAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const used = amount.used ?? (amount.usedFraction !== undefined ? amount.usedFraction * 100 : undefined);
	const remainingFraction =
		amount.remainingFraction ??
		(amount.usedFraction !== undefined ? Math.max(0, 1 - amount.usedFraction) : undefined);
	const unit = amount.unit === "percent" ? "%" : ` ${amount.unit}`;
	const usedText = used === undefined ? "unknown used" : `${used.toFixed(2)}${unit} used`;
	const remainingText = remainingFraction === undefined ? "" : ` (${(remainingFraction * 100).toFixed(1)}% left)`;
	return `${usedText}${remainingText}`;
}

function formatUsageReportAccount(report: UsageReport, limit: UsageLimit, index: number): string {
	const metaOrgName = sanitizeOptionalUsageLine(report.metadata?.orgName);
	const metaOrgId = sanitizeOptionalUsageLine(report.metadata?.orgId);
	const org = metaOrgName ?? metaOrgId;
	// Two subscriptions (orgs) can share one email — suffix the org so the rows
	// are tellable apart.
	const email = sanitizeOptionalUsageLine(report.metadata?.email);
	if (email) return org ? `${email} (${org})` : email;
	// Guard metadata values for truthiness before using, then fall back to scope.
	// ?? won't help here: empty string is not null/undefined, so it would suppress
	// a valid scoped fallback (e.g. metadata.accountId="" hides limit.scope.accountId).
	const accountId = sanitizeOptionalUsageLine(report.metadata?.accountId) ?? sanitizeOptionalUsageLine(limit.scope.accountId);
	if (accountId) {
		return org && org !== accountId ? `${accountId} (${org})` : accountId;
	}
	const projectId = sanitizeOptionalUsageLine(report.metadata?.projectId) ?? sanitizeOptionalUsageLine(limit.scope.projectId);
	if (projectId) return projectId;
	return `account ${index + 1}`;
}

function renderUsageReports(
	reports: UsageReport[],
	nowMs: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
	usageModelSelectors: readonly string[] = [],
): string {
	const latestFetchedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
	const lines = [`Usage${latestFetchedAt ? ` (${formatDuration(nowMs - latestFetchedAt)} ago)` : ""}`];
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const providerReports = grouped.get(report.provider) ?? [];
		providerReports.push(report);
		grouped.set(report.provider, providerReports);
	}

	for (const [provider, providerReports] of [...grouped.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		lines.push("", sanitizeUsageLine(formatProviderName(provider)));
		const reportingModels = usageModelSelectors.filter(selector => selector.startsWith(`${provider}/`));
		if (reportingModels.length > 0) {
			lines.push("  Models with usage data");
			for (const selector of reportingModels) lines.push(`    ${sanitizeText(selector)}`);
		}
		const activeAccount = resolveActiveAccount?.(provider);
		// Provider-wide disclaimers render once per provider, not per limit.
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		for (const note of providerNotes)
			lines.push(`  ${sanitizeText(note.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))}`);
		for (const report of providerReports) {
			const inUse = reportMatchesActiveAccount(report, activeAccount);
			const savedResets = report.resetCredits?.availableCount ?? 0;
			if (savedResets > 0) {
				const resetLabel =
					sanitizeOptionalUsageLine(report.metadata?.email) ??
					sanitizeOptionalUsageLine(report.metadata?.accountId) ??
					"account";
				lines.push(
					`- ${resetLabel}: ${savedResets} saved rate-limit reset${savedResets === 1 ? "" : "s"} available — /usage reset to spend`,
				);
				const credits = report.resetCredits?.credits;
				if (credits) {
					for (const credit of credits) {
						if (credit.expiresAt) {
							const expiryMs = Date.parse(credit.expiresAt);
							if (!Number.isNaN(expiryMs)) {
								const remaining = expiryMs - nowMs;
								if (remaining > 0) {
									lines.push(
										`  expires in ${formatDuration(remaining)} (${sanitizeUsageLine(credit.expiresAt.slice(0, 10))})`,
									);
								} else {
									lines.push(`  expired (${sanitizeUsageLine(credit.expiresAt.slice(0, 10))})`);
								}
							}
						}
					}
				}
			}
			if (report.limits.length === 0) {
				const email = sanitizeOptionalUsageLine(report.metadata?.email) ?? "account";
				lines.push(`- ${email}: no limits reported`);
				continue;
			}
			for (let index = 0; index < report.limits.length; index++) {
				const limit = report.limits[index]!;
				const label = sanitizeUsageLine(limit.label);
				const window = sanitizeOptionalUsageLine(limit.window?.label ?? limit.scope.windowId);
				// Skip the tier suffix when the label already names it (e.g. Anthropic's
				// "Claude 7 Day (Fable)" with scope.tier "fable") — mirrors limitTitle in usage-cli.
				const tierValue = sanitizeOptionalUsageLine(limit.scope.tier);
				const tier = tierValue && !label.toLowerCase().includes(tierValue.toLowerCase()) ? ` (${tierValue})` : "";
				lines.push(`- ${label}${tier}${formatWindowSuffix(label, window)}`);
				lines.push(
					`  ${formatUsageReportAccount(report, limit, index)}: ${formatUsageAmount(limit)}${inUse ? "  ← in use by this session" : ""}`,
				);
				lines.push(`  ${renderAsciiBar(limit.amount.usedFraction)}`);
				if (limit.window?.resetsAt && limit.window.resetsAt > nowMs) {
					const resetLabel = sanitizeOptionalUsageLine(limit.window.resetLabel) ?? "resets";
					lines.push(`  ${resetLabel} in ${formatDuration(limit.window.resetsAt - nowMs)}`);
				}
				if (limit.notes && limit.notes.length > 0)
					lines.push(
						`  ${limit.notes.map(n => sanitizeText(n.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))).join(" • ")}`,
					);
			}
		}
	}
	return ["```", ...lines, "```"].join("\n");
}

/**
 * Build the `/usage` ACP-mode text. Prefers provider-reported limits when the
 * session exposes `fetchUsageReports`; otherwise falls back to the local
 * session-manager tallies.
 */
export async function buildUsageReportText(runtime: SlashCommandRuntime): Promise<string> {
	const provider = runtime.session as SlashCommandRuntime["session"] & {
		fetchUsageReports?: () => Promise<UsageReport[] | null>;
		getUsageReportingModelSelectors?: (reports: readonly UsageReport[]) => string[];
	};
	if (provider.fetchUsageReports) {
		const reports = await provider.fetchUsageReports();
		if (reports && reports.length > 0) {
			const currentProvider = runtime.session.model?.provider;
			const activeAccount = currentProvider
				? runtime.session.modelRegistry.authStorage.getOAuthAccountIdentity(
						currentProvider,
						runtime.session.sessionId,
					)
				: undefined;
			const usageModelSelectors = provider.getUsageReportingModelSelectors?.(reports) ?? [];
			return renderUsageReports(
				reports,
				Date.now(),
				providerId => (providerId === currentProvider ? activeAccount : undefined),
				usageModelSelectors,
			);
		}
	}

	const stats = runtime.session.sessionManager.getUsageStatistics();
	const orchestrationTokens = stats.orchestrationInput + stats.orchestrationOutput + stats.orchestrationCacheRead;
	return [
		"Usage",
		`Input tokens: ${stats.input}`,
		`Output tokens: ${stats.output}`,
		`Cache read tokens: ${stats.cacheRead}`,
		`Cache write tokens: ${stats.cacheWrite}`,
		`Total tokens: ${stats.totalTokens}`,
		...(orchestrationTokens > 0 ? [`Orchestration tokens: ${orchestrationTokens}`] : []),
		`Premium requests: ${stats.premiumRequests}`,
		`Cost: $${stats.cost.toFixed(6)}`,
	].join("\n");
}

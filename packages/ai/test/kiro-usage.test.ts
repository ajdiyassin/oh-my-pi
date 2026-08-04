import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { kiroUsageProvider } from "@oh-my-pi/pi-ai/usage/kiro";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/EXAMPLEPROFILE";

function credential(overrides: Partial<UsageFetchParams["credential"]> = {}): UsageFetchParams["credential"] {
	return { type: "oauth", accessToken: "kiro-access", orgId: PROFILE_ARN, ...overrides };
}

/** Capture-derived `GetUsageLimits` payload (credit-metered, one breakdown row). */
function livePayload(overrides: Record<string, unknown> = {}) {
	return {
		nextDateReset: 1785542400,
		overageConfiguration: { overageStatus: "OVERAGE_DISABLED" },
		subscriptionInfo: { subscriptionTitle: "Kiro Pro", type: "SUBSCRIPTION" },
		usageBreakdownList: [
			{
				resourceType: "CREDIT",
				displayName: "credit",
				displayNamePlural: "credits",
				unit: "CREDIT_UNIT",
				currency: "USD",
				currentUsage: 1417,
				currentUsageWithPrecision: 1417.43,
				usageLimit: 2000,
				usageLimitWithPrecision: 2000.0,
				overageCap: 2500,
				overageCapWithPrecision: 2500.0,
				currentOverages: 0,
				currentOveragesWithPrecision: 0.0,
				overageCharges: 0.0,
				overageRate: 0.04,
				bonuses: [],
				overageCredits: [],
				nextDateReset: 1785542400,
			},
		],
		userInfo: { userId: "should-never-be-exposed" },
		...overrides,
	};
}

function ctx(payload: unknown, capture?: { url?: string; init?: RequestInit }): UsageFetchContext {
	const fetch: FetchImpl = async (input, init) => {
		if (capture) {
			capture.url = String(input);
			capture.init = init;
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

describe("kiro usage provider", () => {
	it("requests the profile-scoped control-plane target and normalizes the credit bucket", async () => {
		const capture: { url?: string; init?: RequestInit } = {};
		const report = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: credential(), signal: undefined },
			ctx(livePayload(), capture),
		);

		// Region comes from the profile ARN, never a guessed default.
		expect(capture.url).toBe("https://management.us-east-1.kiro.dev/");
		const headers = new Headers(capture.init?.headers);
		expect(headers.get("x-amz-target")).toBe("KiroControlPlaneBearerService.GetUsageLimits");
		expect(headers.get("authorization")).toBe("Bearer kiro-access");
		expect(JSON.parse(String(capture.init?.body))).toEqual({ origin: "KIRO_CLI", profileArn: PROFILE_ARN });

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(1);
		const limit = report!.limits[0]!;
		expect(limit.id).toBe("credit");
		expect(limit.label).toBe("credits");
		// `*WithPrecision` wins over the truncated sibling.
		expect(limit.amount.used).toBe(1417.43);
		expect(limit.amount.limit).toBe(2000);
		expect(limit.amount.remaining).toBeCloseTo(582.57, 2);
		expect(limit.amount.usedFraction).toBeCloseTo(0.708715, 5);
		expect(limit.status).toBe("ok");
		// Credits are neither tokens nor USD; the unit must not be misreported.
		expect(limit.amount.unit).toBe("unknown");
		// Epoch seconds are promoted to milliseconds.
		expect(limit.window?.resetsAt).toBe(1785542400 * 1000);
		expect(limit.scope.tier).toBe("Kiro Pro");
	});

	it("never exposes the full profile ARN or upstream account identifiers", async () => {
		const report = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: credential(), signal: undefined },
			ctx(livePayload()),
		);

		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain(PROFILE_ARN);
		expect(serialized).not.toContain("111122223333");
		expect(serialized).not.toContain("should-never-be-exposed");
		// Only the trailing profile segment identifies the quota scope.
		expect(report!.limits[0]!.scope.orgId).toBe("EXAMPLEPROFILE");
		expect(report!.metadata?.orgId).toBe("EXAMPLEPROFILE");
	});

	it("reports overage and bonus notes only from values the response stated", async () => {
		const payload = livePayload({
			overageConfiguration: { overageStatus: "OVERAGE_ENABLED" },
			usageBreakdownList: [
				{
					...livePayload().usageBreakdownList[0],
					currentUsage: 2000,
					currentUsageWithPrecision: 2000.0,
					currentOverages: 120,
					currentOveragesWithPrecision: 120.5,
					overageCharges: 4.82,
					bonuses: [{ amount: 50 }],
					overageCredits: [{ amount: 10 }],
				},
			],
		});
		const report = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: credential(), signal: undefined },
			ctx(payload),
		);

		const limit = report!.limits[0]!;
		expect(limit.status).toBe("exhausted");
		expect(limit.notes).toEqual([
			"overage 120.5 / 2500",
			"overage charges 4.82 USD",
			"overage rate 0.04/credits",
			"overage enabled",
			"1 bonus grant",
			"1 overage credit",
		]);
	});

	it("maps request-denominated resources to the requests unit", async () => {
		const payload = livePayload({
			usageBreakdownList: [
				{ ...livePayload().usageBreakdownList[0], resourceType: "AGENTIC_REQUEST", displayNamePlural: "requests" },
			],
		});
		const report = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: credential(), signal: undefined },
			ctx(payload),
		);

		expect(report!.limits[0]!.amount.unit).toBe("requests");
		expect(report!.limits[0]!.id).toBe("agentic_request");
	});

	it("returns null for API-key credentials and for a missing or invalid profile", async () => {
		const apiKeyReport = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: { type: "api_key", apiKey: "ksk_test" }, signal: undefined },
			ctx(livePayload()),
		);
		expect(apiKeyReport).toBeNull();

		const noProfile = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: credential({ orgId: undefined }), signal: undefined },
			ctx(livePayload()),
		);
		expect(noProfile).toBeNull();

		const badProfile = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: credential({ orgId: "not-an-arn" }), signal: undefined },
			ctx(livePayload()),
		);
		expect(badProfile).toBeNull();
	});

	it("rejects an empty or unusable breakdown instead of reporting a zeroed quota", async () => {
		const empty = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: credential(), signal: undefined },
			ctx(livePayload({ usageBreakdownList: [] })),
		);
		expect(empty).toBeNull();

		const unusable = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: credential(), signal: undefined },
			ctx(livePayload({ usageBreakdownList: [{ resourceType: "CREDIT" }] })),
		);
		expect(unusable).toBeNull();
	});

	it("rejects more breakdown entries than the bounded report contract permits", async () => {
		const entry = livePayload().usageBreakdownList[0];
		const report = await kiroUsageProvider.fetchUsage(
			{
				provider: "kiro",
				credential: credential(),
				signal: undefined,
			},
			ctx(livePayload({ usageBreakdownList: Array.from({ length: 33 }, () => entry) })),
		);

		expect(report).toBeNull();
	});

	it("gates support on an OAuth credential with a validated profile", () => {
		expect(kiroUsageProvider.supports!({ provider: "kiro", credential: credential() })).toBe(true);
		expect(
			kiroUsageProvider.supports!({ provider: "kiro", credential: { type: "api_key", apiKey: "ksk_test" } }),
		).toBe(false);
		expect(kiroUsageProvider.supports!({ provider: "kiro", credential: credential({ orgId: "nope" }) })).toBe(false);
	});
});

import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

describe("PR 3318 repro", () => {
	it("falls back to scoped account when metadata identities are empty strings", async () => {
		const report: UsageReport = {
			provider: "test-provider",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "daily",
					label: "Daily",
					scope: { provider: "test-provider", accountId: "scoped-account", projectId: "scoped-project" },
					amount: { used: 1, usedFraction: 0.1, unit: "requests" },
				},
			],
			metadata: { email: "", accountId: "", projectId: "" },
		};
		const text = await buildUsageReportText({
			session: {
				model: undefined,
				fetchUsageReports: async () => [report],
				getUsageReportingModelSelectors: () => ["test-provider/coding-plan-model"],
			},
		} as never);

		expect(text).toContain("scoped-account: 1.00 requests used");
		expect(text).not.toContain("account 1: 1.00 requests used");
		expect(text).toContain("Models with usage data");
		expect(text).toContain("test-provider/coding-plan-model");
	});

	it("sanitizes provider-controlled usage labels before rendering", async () => {
		const report: UsageReport = {
			provider: "test-provider",
			fetchedAt: Date.now(),
			metadata: {
				email: "\u001b[32muser\nname\t",
				orgName: "\u001b[33mteam\norg\t",
			},
			limits: [
				{
					id: "daily",
					label: "\u001b[31mCredits\nInjected\t",
					scope: { provider: "test-provider", accountId: "account\nvalue", tier: "\u001b[34mPro\t" },
					window: {
						id: "daily",
						label: "\u001b[35mDaily\nwindow\t",
						resetLabel: "\u001b[36mresets\nsoon\t",
						resetsAt: Date.now() + 60_000,
					},
					amount: { unit: "requests", used: 1, limit: 10, usedFraction: 0.1 },
				},
			],
		};
		const text = await buildUsageReportText({
			session: {
				model: undefined,
				fetchUsageReports: async () => [report],
			},
		} as never);

		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\t");
		expect(text).not.toContain("\nInjected");
		expect(text).toContain("Credits Injected");
		expect(text).toContain("user name (team org)");
	});
});

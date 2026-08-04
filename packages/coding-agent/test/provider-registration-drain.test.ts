import { describe, expect, it } from "bun:test";
import { drainPendingProviderRegistrations } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

describe("drainPendingProviderRegistrations", () => {
	it("isolates one registration failure and continues with later providers", () => {
		const registered: string[] = [];
		const runtime = {
			pendingProviderRegistrations: [
				{ name: "broken-provider", config: {}, sourceId: "extension://broken" },
				{ name: "healthy-provider", config: {}, sourceId: "extension://healthy" },
			],
		};
		const modelRegistry = {
			registerProvider(name: string, _config: ProviderConfig, sourceId: string): void {
			registered.push(`${name}@${sourceId}`);
			if (name === "broken-provider") throw new Error("invalid provider configuration");
			},
		};

		drainPendingProviderRegistrations(runtime, modelRegistry);

		expect(registered).toEqual(["broken-provider@extension://broken", "healthy-provider@extension://healthy"]);
		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});
});

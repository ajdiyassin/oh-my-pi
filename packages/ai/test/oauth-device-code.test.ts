import { describe, expect, it } from "bun:test";
import { pollOAuthDeviceCodeFlow } from "@oh-my-pi/pi-ai/oauth";

describe("OAuth device-code polling", () => {
	it("exports the legacy device-code poll helper for external providers", async () => {
		const value = await pollOAuthDeviceCodeFlow({
			poll: () => ({ status: "complete", value: { access: "token" } }),
		});

		expect(value).toEqual({ access: "token" });
	});

	it("surfaces provider failure messages", async () => {
		expect(
			pollOAuthDeviceCodeFlow({
				poll: () => ({ status: "failed", message: "authorization denied" }),
			}),
		).rejects.toThrow("authorization denied");
	});

	it("times out pending device flows", async () => {
		expect(
			pollOAuthDeviceCodeFlow({
				expiresInSeconds: 0.001,
				poll: () => ({ status: "pending" }),
			}),
		).rejects.toThrow("Device flow timed out");
	});
	it("stops polling immediately when the caller cancels during the wait", async () => {
		const controller = new AbortController();
		let polls = 0;
		await expect(
			pollOAuthDeviceCodeFlow({
				expiresInSeconds: 60,
				intervalSeconds: 1,
				waitBeforeFirstPoll: true,
				signal: controller.signal,
				sleep: async () => {
					controller.abort();
				},
				poll: () => {
					polls += 1;
					return { status: "pending" };
				},
			}),
		).rejects.toThrow("Login cancelled");
		expect(polls).toBe(0);
	});
});

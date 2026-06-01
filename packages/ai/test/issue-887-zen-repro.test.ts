/**
 * OpenCode Zen: minimax-m3-free (and other MiniMax free models) are declared
 * with `provider.npm = "@ai-sdk/anthropic"` in models.dev, but OpenCode Zen
 * serves them at the OpenAI-compatible endpoint (`/v1/chat/completions`), not
 * the Anthropic Messages endpoint. The resolver must route them to
 * openai-completions (same root cause as issue #887 for OpenCode Go).
 */
import { describe, expect, test } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	type ModelsDevModel,
} from "../src/provider-models/openai-compat";

const OPENCODE_ZEN_BASE = "https://opencode.ai/zen/v1";

describe("opencode-zen resolver routes minimax-m3-free to openai-completions (issue #887 class)", () => {
	const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "opencode-zen");

	// models.dev declares minimax-m3-free with `provider.npm = "@ai-sdk/anthropic"`,
	// but OpenCode Zen serves it via the openai-compatible endpoint.
	const npmAnthropic: ModelsDevModel = { provider: { npm: "@ai-sdk/anthropic" }, tool_call: true };

	test("minimax-m3-free resolves to openai-completions on /v1/chat/completions", () => {
		const resolved = descriptor?.resolveApi?.("minimax-m3-free", npmAnthropic);
		expect(resolved).toEqual({ api: "openai-completions", baseUrl: OPENCODE_ZEN_BASE });
	});
});

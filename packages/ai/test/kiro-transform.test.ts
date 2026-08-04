import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { transformKiroRequest } from "@oh-my-pi/pi-ai/providers/kiro/index";
import type { AssistantMessage, Context, Model, Tool, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const lookupParameters = type({ path: "string" });
const lookupTool: Tool<typeof lookupParameters> = {
	name: "lookup",
	description: "Look up a path.",
	parameters: lookupParameters,
};

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createModel(
	options: { reasoning?: boolean; thinking?: Model["thinking"]; maxTokens?: number } = {},
): Model<"kiro-api"> {
	return buildModel({
		id: "kiro-test-model",
		name: "Kiro test model",
		api: "kiro-api",
		provider: "kiro",
		baseUrl: "https://runtime.us-east-1.kiro.dev/",
		reasoning: options.reasoning ?? false,
		...(options.thinking ? { thinking: options.thinking } : {}),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: options.maxTokens ?? 4_096,
	});
}

function assistantToolCall(id: string, stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "lookup", arguments: { path: "README.md" } }],
		api: "kiro-api",
		provider: "kiro",
		model: "kiro-test-model",
		usage: zeroUsage,
		stopReason,
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, isError = false) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "lookup",
		content: [{ type: "text" as const, text: isError ? "lookup failed" : "file contents" }],
		isError,
		timestamp: 2,
	};
}

describe("Kiro request transformation", () => {
	test("serializes images, tools, paired historical tool results, and profile-safe tool ids", () => {
		const jpegData = "aGVsbG8=";
		const pngData = "iVBORw0KGgo=";
		const context: Context = {
			systemPrompt: ["Follow the system instruction."],
			messages: [
				{ role: "user", content: "Earlier question", timestamp: 0 },
				assistantToolCall("wire/tool.id"),
				toolResult("wire/tool.id"),
				{
					role: "user",
					content: [
						{ type: "text", text: "Current question" },
						{ type: "image", data: jpegData, mimeType: "image/jpeg" },
						{ type: "image", data: pngData, mimeType: "image/png" },
					],
					timestamp: 3,
				},
			],
			tools: [lookupTool],
		};

		const request = transformKiroRequest(createModel(), context);
		const history = request.conversationState.history ?? [];
		const current = request.conversationState.currentMessage.userInputMessage;
		const historicalAssistant = history.find(entry => entry.assistantResponseMessage)?.assistantResponseMessage;
		const historicalResult = history.find(entry => entry.userInputMessage?.userInputMessageContext?.toolResults)
			?.userInputMessage?.userInputMessageContext?.toolResults?.[0];

		expect(history[0]?.userInputMessage?.content).toContain("Follow the system instruction.");
		expect(current.content).toBe("Current question");
		expect(current.images).toEqual([
			{ format: "jpeg", source: { bytes: jpegData } },
			{ format: "png", source: { bytes: pngData } },
		]);
		expect(current.userInputMessageContext?.tools?.[0]?.toolSpecification).toMatchObject({
			name: "lookup",
			description: "Look up a path.",
		});
		expect(current.userInputMessageContext?.tools?.[0]?.toolSpecification.inputSchema.json).toMatchObject({
			type: "object",
			properties: { path: { type: "string" } },
		});
		expect(historicalAssistant?.toolUses?.[0]?.name).toBe("lookup");
		expect(historicalAssistant?.toolUses?.[0]?.toolUseId).toMatch(/^call_/);
		expect(historicalResult?.status).toBe("success");
		expect(historicalResult?.toolUseId).toBe(historicalAssistant?.toolUses?.[0]?.toolUseId);
	});

	test("clamps adaptive effort and output cap, and omits reasoning when disabled", () => {
		const model = createModel({
			reasoning: true,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.High],
				defaultLevel: Effort.Low,
				supportsDisplay: true,
			},
			maxTokens: 4_096,
		});
		const context: Context = { messages: [{ role: "user", content: "Think", timestamp: 0 }] };

		const clamped = transformKiroRequest(model, context, {
			reasoning: Effort.Medium,
			hideThinkingSummary: true,
			maxTokens: 9_999,
		});
		expect(clamped.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "omitted" },
			output_config: { effort: "low" },
			max_tokens: 4_096,
		});

		const disabled = transformKiroRequest(model, context, { reasoning: Effort.High, disableReasoning: true });
		expect(disabled.additionalModelRequestFields).toBeUndefined();
	});

	test("drops an aborted assistant turn together with its orphaned tool result", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("unfinished", "aborted"),
				toolResult("unfinished"),
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};

		const request = transformKiroRequest(createModel(), context);
		const history = request.conversationState.history ?? [];
		expect(history.some(entry => entry.assistantResponseMessage !== undefined)).toBe(false);
		expect(history.some(entry => entry.userInputMessage?.userInputMessageContext?.toolResults !== undefined)).toBe(
			false,
		);
	});

	test("fails closed for unsupported user image formats", () => {
		for (const mimeType of ["image/gif", "image/webp", "image/bmp"] as const) {
			const context: Context = {
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "unsupported-image", mimeType }],
						timestamp: 0,
					},
				],
			};

			expect(() => transformKiroRequest(createModel(), context)).toThrow(/Kiro does not support image type/);
		}
	});

	test("rejects images in tool results instead of emitting an unsupported wire shape", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("tool-1"),
				{
					...toolResult("tool-1"),
					content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				},
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};

		expect(() => transformKiroRequest(createModel(), context)).toThrow(/tool-result image input is not enabled/);
	});
});

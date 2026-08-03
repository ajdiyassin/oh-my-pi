import { prompt } from "@oh-my-pi/pi-utils";
import type {
	AssistantMessage,
	Context,
	Effort,
	ImageContent,
	Message,
	Model,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../../types";
import { toolWireSchema } from "../../utils/schema/wire";
import { buildKiroModelRequestFields } from "./adaptive-thinking";
import { createKiroToolUseIdNormalizer } from "./id-normalizer";
import assistantHistoryPrompt from "./prompts/assistant-history.md" with { type: "text" };
import continuationPrompt from "./prompts/continuation.md" with { type: "text" };
import defaultToolDescriptionPrompt from "./prompts/default-tool-description.md" with { type: "text" };
import historicalToolDescriptionPrompt from "./prompts/historical-tool-description.md" with { type: "text" };
import joinedContentPrompt from "./prompts/joined-content.md" with { type: "text" };
import toolResultsPrompt from "./prompts/tool-results.md" with { type: "text" };
import type {
	KiroAssistantResponseMessage,
	KiroHistoryEntry,
	KiroImageBlock,
	KiroRequest,
	KiroToolResult,
	KiroToolSpec,
	KiroToolUse,
	KiroUserInputMessage,
} from "./types";

const CONTINUATION_PROMPT = prompt.render(continuationPrompt);
const HISTORICAL_TOOL_DESCRIPTION = prompt.render(historicalToolDescriptionPrompt);
const TOOL_RESULTS_PROMPT = prompt.render(toolResultsPrompt);

function joinPromptContent(prefix: string, content: string): string {
	return prompt.render(joinedContentPrompt, { prefix, content });
}

function textContent(message: Message): string {
	if (typeof message.content === "string") return message.content.toWellFormed();
	let text = "";
	for (const part of message.content) {
		if (part.type === "text") text += part.text;
		else if (part.type === "thinking") text += part.thinking;
	}
	return text.toWellFormed();
}

function imageFormat(mimeType: string): KiroImageBlock["format"] {
	switch (mimeType.trim().toLowerCase()) {
		case "image/jpeg":
		case "image/jpg":
			return "jpeg";
		case "image/png":
			return "png";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			throw new Error(`Kiro does not support image type: ${mimeType}`);
	}
}

function isImageContent(part: unknown): part is ImageContent {
	return typeof part === "object" && part !== null && "type" in part && part.type === "image" && "mimeType" in part;
}

function imageContent(message: Message): KiroImageBlock[] {
	if (typeof message.content === "string") return [];
	const images: KiroImageBlock[] = [];
	for (const part of message.content) {
		if (!isImageContent(part)) continue;
		images.push({ format: imageFormat(part.mimeType), source: { bytes: part.data } });
	}
	return images;
}

function parseToolArguments(call: ToolCall): Record<string, unknown> {
	if (typeof call.arguments !== "string") return call.arguments;
	const value: unknown = JSON.parse(call.arguments);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Kiro historical tool call ${call.id} must contain a JSON object`);
	}
	return value as Record<string, unknown>;
}

function assistantMessage(
	message: AssistantMessage,
	normalizeId: (id: string) => string,
): KiroAssistantResponseMessage | undefined {
	const thinking: string[] = [];
	let text = "";
	const toolUses: KiroToolUse[] = [];
	for (const part of message.content) {
		if (part.type === "text") text += part.text;
		else if (part.type === "thinking") thinking.push(part.thinking);
		else if (part.type === "toolCall") {
			toolUses.push({ name: part.name, toolUseId: normalizeId(part.id), input: parseToolArguments(part) });
		}
	}
	const content = prompt.render(assistantHistoryPrompt, { thinking, text });
	if (!content && toolUses.length === 0) return undefined;
	return { content: content.toWellFormed(), ...(toolUses.length > 0 ? { toolUses } : {}) };
}

function assertNoToolResultImages(message: ToolResultMessage): void {
	if (message.content.some(part => part.type === "image")) {
		throw new Error("Kiro tool-result image input is not enabled: only user-message image wire shape is verified");
	}
}

function toolResult(message: ToolResultMessage, normalizeId: (id: string) => string): KiroToolResult {
	assertNoToolResultImages(message);
	return {
		content: [{ text: textContent(message) }],
		status: message.isError ? "error" : "success",
		toolUseId: normalizeId(message.toolCallId),
	};
}

function toolsToKiro(tools: readonly Tool[]): KiroToolSpec[] {
	return tools.map(tool => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description.trim() || prompt.render(defaultToolDescriptionPrompt, { toolName: tool.name }),
			inputSchema: { json: toolWireSchema(tool) },
		},
	}));
}

function historicalToolNames(history: readonly KiroHistoryEntry[]): Set<string> {
	const names = new Set<string>();
	for (const entry of history) {
		for (const use of entry.assistantResponseMessage?.toolUses ?? []) names.add(use.name);
	}
	return names;
}

function appendHistoricalToolPlaceholders(tools: KiroToolSpec[], history: readonly KiroHistoryEntry[]): void {
	const current = new Set(tools.map(tool => tool.toolSpecification.name));
	for (const name of historicalToolNames(history)) {
		if (current.has(name)) continue;
		tools.push({
			toolSpecification: {
				name,
				description: HISTORICAL_TOOL_DESCRIPTION,
				inputSchema: { json: { type: "object", properties: {} } },
			},
		});
	}
}

function userMessage(content: string, modelId: string): KiroUserInputMessage {
	return { content: content.toWellFormed(), modelId, origin: "KIRO_CLI" };
}

/**
 * Drop assistant turns that never completed, plus the tool results that answered
 * their calls. Keeping an orphaned result would ship a `toolUseId` with no
 * matching `toolUse` in history, which the runtime rejects.
 */
function retainPairedMessages(messages: readonly Message[]): Message[] {
	const droppedToolCallIds = new Set<string>();
	const retained: Message[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			for (const part of message.content) {
				if (part.type === "toolCall") droppedToolCallIds.add(part.id);
			}
			continue;
		}
		if (message.role === "toolResult" && droppedToolCallIds.has(message.toolCallId)) continue;
		retained.push(message);
	}
	return retained;
}

/** Convert OMP context into the capture-verified Kiro runtime request. */
export function transformKiroRequest(
	model: Model,
	context: Context,
	options: {
		reasoning?: Effort;
		disableReasoning?: boolean;
		hideThinkingSummary?: boolean;
		/** Request-level output cap; bounded by the model ceiling before serialization. */
		maxTokens?: number;
	} = {},
): KiroRequest {
	const normalizer = createKiroToolUseIdNormalizer();
	const messages = retainPairedMessages(context.messages);

	let currentStart = messages.length - 1;
	while (currentStart > 0 && messages[currentStart]?.role === "toolResult") currentStart--;
	if (currentStart >= 0 && messages[currentStart]?.role === "assistant") {
		const assistant = messages[currentStart] as AssistantMessage;
		if (!assistant.content.some(part => part.type === "toolCall")) currentStart++;
	}
	const historyMessages = messages.slice(0, currentStart);
	const currentMessages = messages.slice(currentStart);
	const history: KiroHistoryEntry[] = [];
	let systemPending = (context.systemPrompt ?? []).join("\n");

	for (let index = 0; index < historyMessages.length; index++) {
		const message = historyMessages[index];
		if (message.role === "user" || message.role === "developer") {
			let content = textContent(message);
			if (systemPending) {
				content = joinPromptContent(systemPending, content);
				systemPending = "";
			}
			const images = imageContent(message);
			const previous = history.at(-1)?.userInputMessage;
			if (previous && images.length === 0 && !previous.images?.length) {
				previous.content = joinPromptContent(previous.content, content);
			} else {
				history.push({
					userInputMessage: {
						...userMessage(content, model.requestModelId ?? model.id),
						...(images.length > 0 ? { images } : {}),
					},
				});
			}
			continue;
		}
		if (message.role === "assistant") {
			const converted = assistantMessage(message, id => normalizer.normalize(id));
			if (converted) history.push({ assistantResponseMessage: converted });
			continue;
		}
		const results = [toolResult(message, id => normalizer.normalize(id))];
		while (historyMessages[index + 1]?.role === "toolResult") {
			index++;
			results.push(toolResult(historyMessages[index] as ToolResultMessage, id => normalizer.normalize(id)));
		}
		history.push({
			userInputMessage: {
				...userMessage(TOOL_RESULTS_PROMPT, model.requestModelId ?? model.id),
				userInputMessageContext: { toolResults: results },
			},
		});
	}

	let currentContent = "";
	let currentImages: KiroImageBlock[] = [];
	const currentResults: KiroToolResult[] = [];
	const first = currentMessages[0];
	if (first?.role === "assistant") {
		const converted = assistantMessage(first, id => normalizer.normalize(id));
		if (converted) history.push({ assistantResponseMessage: converted });
		for (const message of currentMessages.slice(1)) {
			if (message.role === "toolResult") currentResults.push(toolResult(message, id => normalizer.normalize(id)));
		}
		currentContent = currentResults.length > 0 ? TOOL_RESULTS_PROMPT : CONTINUATION_PROMPT;
	} else if (first?.role === "toolResult") {
		for (const message of currentMessages) {
			if (message.role === "toolResult") currentResults.push(toolResult(message, id => normalizer.normalize(id)));
		}
		currentContent = TOOL_RESULTS_PROMPT;
	} else if (first) {
		currentContent = textContent(first);
		currentImages = imageContent(first);
	}
	if (systemPending) currentContent = joinPromptContent(systemPending, currentContent);

	const toolSpecs = toolsToKiro(context.tools ?? []);
	appendHistoricalToolPlaceholders(toolSpecs, history);
	const currentContext: NonNullable<KiroUserInputMessage["userInputMessageContext"]> = {};
	if (currentResults.length > 0) currentContext.toolResults = currentResults;
	if (toolSpecs.length > 0) currentContext.tools = toolSpecs;
	const requestFields = options.disableReasoning
		? undefined
		: buildKiroModelRequestFields(model, options.reasoning, options.hideThinkingSummary, options.maxTokens);
	return {
		agentMode: "vibe",
		conversationState: {
			chatTriggerType: "MANUAL",
			agentTaskType: "vibe",
			conversationId: crypto.randomUUID(),
			currentMessage: {
				userInputMessage: {
					...userMessage(currentContent, model.requestModelId ?? model.id),
					...(currentImages.length > 0 ? { images: currentImages } : {}),
					...(Object.keys(currentContext).length > 0 ? { userInputMessageContext: currentContext } : {}),
				},
			},
			...(history.length > 0 ? { history } : {}),
		},
		...(requestFields ? { additionalModelRequestFields: requestFields } : {}),
	};
}

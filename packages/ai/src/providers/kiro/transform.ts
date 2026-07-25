import type {
	AssistantMessage,
	Context,
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
import type {
	KiroAssistantResponseMessage,
	KiroHistoryEntry,
	KiroRequest,
	KiroToolResult,
	KiroToolSpec,
	KiroToolUse,
	KiroUserInputMessage,
} from "./types";

function textContent(message: Message): string {
	if (typeof message.content === "string") return message.content.toWellFormed();
	let text = "";
	for (const part of message.content) {
		if (part.type === "text") text += part.text;
		else if (part.type === "thinking") text += part.thinking;
	}
	return text.toWellFormed();
}

function rejectImages(message: Message): void {
	if (typeof message.content === "string") return;
	if (message.content.some((part): part is ImageContent => part.type === "image")) {
		throw new Error("Kiro image input is not enabled: the retained protocol evidence does not prove its wire shape");
	}
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
	let thinking = "";
	let text = "";
	const toolUses: KiroToolUse[] = [];
	for (const part of message.content) {
		if (part.type === "text") text += part.text;
		else if (part.type === "thinking") thinking += `<thinking>${part.thinking}</thinking>\n\n`;
		else if (part.type === "toolCall") {
			toolUses.push({ name: part.name, toolUseId: normalizeId(part.id), input: parseToolArguments(part) });
		}
	}
	const content = `${thinking}${text}`;
	if (!content && toolUses.length === 0) return undefined;
	return { content: content.toWellFormed(), ...(toolUses.length > 0 ? { toolUses } : {}) };
}

function toolResult(message: ToolResultMessage, normalizeId: (id: string) => string): KiroToolResult {
	rejectImages(message);
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
			description: tool.description.trim() || `Use the ${tool.name} tool.`,
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
				description: "Tool used in conversation history.",
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
		reasoning?: Parameters<typeof buildKiroModelRequestFields>[1];
		disableReasoning?: boolean;
		hideThinkingSummary?: boolean;
	} = {},
): KiroRequest {
	const normalizer = createKiroToolUseIdNormalizer();
	const messages = retainPairedMessages(context.messages);
	for (const message of messages) rejectImages(message);

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
				content = `${systemPending}\n\n${content}`;
				systemPending = "";
			}
			const previous = history.at(-1)?.userInputMessage;
			if (previous) previous.content += `\n\n${content}`;
			else history.push({ userInputMessage: userMessage(content, model.requestModelId ?? model.id) });
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
				...userMessage("Tool results provided.", model.requestModelId ?? model.id),
				userInputMessageContext: { toolResults: results },
			},
		});
	}

	let currentContent = "";
	const currentResults: KiroToolResult[] = [];
	const first = currentMessages[0];
	if (first?.role === "assistant") {
		const converted = assistantMessage(first, id => normalizer.normalize(id));
		if (converted) history.push({ assistantResponseMessage: converted });
		for (const message of currentMessages.slice(1)) {
			if (message.role === "toolResult") currentResults.push(toolResult(message, id => normalizer.normalize(id)));
		}
		currentContent = currentResults.length > 0 ? "Tool results provided." : "Please proceed with the task.";
	} else if (first?.role === "toolResult") {
		for (const message of currentMessages) {
			if (message.role === "toolResult") currentResults.push(toolResult(message, id => normalizer.normalize(id)));
		}
		currentContent = "Tool results provided.";
	} else if (first) {
		currentContent = textContent(first);
	}
	if (systemPending) currentContent = `${systemPending}${currentContent ? `\n\n${currentContent}` : ""}`;

	const toolSpecs = toolsToKiro(context.tools ?? []);
	appendHistoricalToolPlaceholders(toolSpecs, history);
	const currentContext: NonNullable<KiroUserInputMessage["userInputMessageContext"]> = {};
	if (currentResults.length > 0) currentContext.toolResults = currentResults;
	if (toolSpecs.length > 0) currentContext.tools = toolSpecs;
	const requestFields = options.disableReasoning
		? undefined
		: buildKiroModelRequestFields(model, options.reasoning, options.hideThinkingSummary);
	return {
		conversationState: {
			chatTriggerType: "MANUAL",
			agentTaskType: "vibe",
			conversationId: crypto.randomUUID(),
			currentMessage: {
				userInputMessage: {
					...userMessage(currentContent, model.requestModelId ?? model.id),
					...(Object.keys(currentContext).length > 0 ? { userInputMessageContext: currentContext } : {}),
				},
			},
			...(history.length > 0 ? { history } : {}),
		},
		...(requestFields ? { additionalModelRequestFields: requestFields } : {}),
	};
}

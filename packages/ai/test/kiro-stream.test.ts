import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamKiro, transformKiroRequest } from "@oh-my-pi/pi-ai/providers/kiro/index";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import eventStreamFixture from "./fixtures/kiro/eventstream.json" with { type: "json" };

afterEach(() => {
	vi.useRealTimers();
});

const model: Model<"kiro-api"> = buildModel({
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "kiro-api",
	provider: "kiro",
	baseUrl: "https://runtime.us-east-1.kiro.dev/",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
	thinking: {
		mode: "anthropic-adaptive",
		efforts: [Effort.Low, Effort.Medium, Effort.High],
		defaultLevel: Effort.High,
	},
} as ModelSpec<"kiro-api">);

const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

function assistantWithTool(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "inspect" },
			{ type: "text", text: "Calling tool" },
			{ type: "toolCall", id, name: "read", arguments: { path: "src/a.ts" } },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, content = "file contents"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp: Date.now(),
	};
}

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const bytes = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(bytes.buffer);
	bytes[0] = nameBytes.length;
	bytes.set(nameBytes, 1);
	bytes[1 + nameBytes.length] = 7;
	view.setUint16(2 + nameBytes.length, valueBytes.length, false);
	bytes.set(valueBytes, 4 + nameBytes.length);
	return bytes;
}

function frame(
	eventType: string,
	payload: Record<string, unknown>,
	options: { messageType?: "event" | "exception"; exceptionType?: string } = {},
): Uint8Array {
	const messageType = options.messageType ?? "event";
	const headers = [
		encodeStringHeader(":message-type", messageType),
		...(messageType === "event" ? [encodeStringHeader(":event-type", eventType)] : []),
		...(options.exceptionType ? [encodeStringHeader(":exception-type", options.exceptionType)] : []),
		encodeStringHeader(":content-type", "application/json"),
	];
	const headersLength = headers.reduce((total, header) => total + header.length, 0);
	const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
	const total = 16 + headersLength + payloadBytes.length;
	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headersLength, false);
	view.setUint32(8, Bun.hash.crc32(bytes.subarray(0, 8)) >>> 0, false);
	let offset = 12;
	for (const header of headers) {
		bytes.set(header, offset);
		offset += header.length;
	}
	bytes.set(payloadBytes, offset);
	view.setUint32(total - 4, Bun.hash.crc32(bytes.subarray(0, total - 4)) >>> 0, false);
	return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const size = parts.reduce((total, part) => total + part.length, 0);
	const result = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function eventResponse(bytes: Uint8Array, requestId = "header-request"): Response {
	return new Response(bytes, {
		status: 200,
		headers: {
			"content-type": "application/vnd.amazon.eventstream",
			"x-amzn-requestid": requestId,
		},
	});
}

function normalFrames(): Uint8Array {
	return Uint8Array.fromBase64(eventStreamFixture.sequences.normal.base64);
}

async function drain(stream: AssistantMessageEventStream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

describe("Kiro request transforms", () => {
	it("serializes system/developer history and preserves historical tool pairing without active tools", () => {
		const foreignId = "functions.read:4";
		const context: Context = {
			systemPrompt: ["System policy"],
			messages: [
				user("old request"),
				{ role: "developer", content: "developer context", timestamp: Date.now() },
				assistantWithTool(foreignId),
				toolResult(foreignId),
				user("next request"),
			],
		};
		const request = transformKiroRequest(model, context, { reasoning: Effort.Medium });
		const history = request.conversationState.history ?? [];
		const toolUse = history.flatMap(entry => entry.assistantResponseMessage?.toolUses ?? [])[0];
		const result = history.flatMap(entry => entry.userInputMessage?.userInputMessageContext?.toolResults ?? [])[0];
		expect(history[0].userInputMessage?.content).toBe("System policy\n\nold request\n\ndeveloper context");
		expect(toolUse.toolUseId).toMatch(/^call_[a-z0-9]+$/);
		expect(result.toolUseId).toBe(toolUse.toolUseId);
		expect(request.conversationState.currentMessage.userInputMessage.content).toBe("next request");
		expect(request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools).toEqual([
			{
				toolSpecification: {
					name: "read",
					description: "Tool used in conversation history.",
					inputSchema: { json: { type: "object", properties: {} } },
				},
			},
		]);
		expect(request.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "medium" },
			max_tokens: 64_000,
		});
	});

	it("omits model reasoning fields when reasoning is disabled", () => {
		const request = transformKiroRequest(model, { messages: [user("plain response")] }, { disableReasoning: true });
		expect(request.additionalModelRequestFields).toBeUndefined();
	});

	it("preserves complete tool-result content without an unproven provider cap", () => {
		const content = "x".repeat(250_001);
		const request = transformKiroRequest(model, {
			messages: [assistantWithTool("call-large"), toolResult("call-large", content)],
		});
		expect(
			request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0],
		).toEqual({
			content: [{ text: content }],
			status: "success",
			toolUseId: "call-large",
		});
	});

	it("serializes capture-verified user images and rejects unverified tool-result images", () => {
		const request = transformKiroRequest(model, {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
					],
					timestamp: Date.now(),
				},
			],
		});
		expect(request).toMatchObject({
			agentMode: "vibe",
			conversationState: {
				currentMessage: {
					userInputMessage: {
						content: "describe",
						images: [{ format: "jpeg", source: { bytes: "aGVsbG8=" } }],
					},
				},
			},
		});

		expect(() =>
			transformKiroRequest(model, {
				messages: [
					assistantWithTool("call-image"),
					{
						...toolResult("call-image"),
						content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }],
					},
				],
			}),
		).toThrow("only user-message image wire shape is verified");
	});
});

describe("Kiro native stream", () => {
	it("replays retained reasoning/text/metrics frames with hooks, timing, and response ID", async () => {
		const bytes = concat(normalFrames(), Uint8Array.fromBase64(eventStreamFixture.sequences.metrics.base64));
		let payload: unknown;
		let responseRequestId: string | null | undefined;
		const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: String(input), init });
			return eventResponse(bytes);
		}) as typeof fetch;
		const context: Context = { messages: [user("hello")] };
		const { events, result } = await drain(
			streamKiro(model, context, {
				apiKey: JSON.stringify({
					token: "oauth-access",
					profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/example",
				}),
				fetch: fetchImpl,
				reasoning: Effort.High,
				onPayload(value) {
					payload = value;
				},
				onResponse(response) {
					responseRequestId = response.requestId;
				},
			}),
		);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].url).toBe("https://runtime.us-east-1.kiro.dev/");
		expect(new Headers(fetchCalls[0].init?.headers).get("x-amz-target")).toBe(
			"KiroRuntimeService.GenerateAssistantResponse",
		);
		expect(new Headers(fetchCalls[0].init?.headers).get("authorization")).toBe("Bearer oauth-access");
		expect(payload).toMatchObject({
			profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/example",
			conversationState: { currentMessage: { userInputMessage: { content: "hello" } } },
		});
		expect(responseRequestId).toBe("header-request");
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "<reasoning-delta>" },
			{ type: "text", text: "<assistant-delta>" },
		]);
		expect(result.responseId).toBe("fixture-request");
		expect(result.stopReason).toBe("stop");
		expect(result.usage).toMatchObject({
			input: 10,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 17,
			reasoningTokens: 1,
		});
		expect(result.ttft).toBeNumber();
		expect(result.duration).toBeNumber();
		expect(result.duration!).toBeGreaterThanOrEqual(result.ttft!);
	});
	it("maps a terminal stop reason carried on metadataEvent and tolerates live meteringEvent frames", async () => {
		// Live captures (CLI v3 and Desktop/IDE) report `stopReason` on `metadataEvent`
		// while `assistantResponseEvent` carries content only, and emit a
		// `meteringEvent` billing frame whose `usage` is fractional credits.
		const bytes = concat(
			frame("assistantResponseEvent", { content: "ok" }),
			frame("meteringEvent", { unit: "credit", unitPlural: "credits", usage: 0.0386 }),
			frame("metricsEvent", { usage: { inputTokens: 7, outputTokens: 3 } }),
			frame("metadataEvent", { requestId: "meta-request", stopReason: "MAX_TOKENS" }),
		);
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("hello")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(result.responseId).toBe("meta-request");
		expect(result.stopReason).toBe("length");
		// The credit-denominated metering frame must not contaminate token usage.
		expect(result.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });
	});

	it("ignores unknown additive events without decoding their payload", async () => {
		const unknown = frame("futureEvent", {});
		unknown.set(new TextEncoder().encode("x"), unknown.length - 5);
		new DataView(unknown.buffer).setUint32(
			unknown.length - 4,
			Bun.hash.crc32(unknown.subarray(0, unknown.length - 4)) >>> 0,
			false,
		);
		const bytes = concat(unknown, frame("assistantResponseEvent", { content: "ok", stopReason: "END_TURN" }));
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("future event")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(result.stopReason).toBe("stop");
	});

	it("closes text before a tool call and starts a new block after it", async () => {
		const bytes = concat(
			frame("assistantResponseEvent", { content: "before" }),
			frame("toolUseEvent", { toolUseId: "t1", name: "read", input: '{"path":"a"}', stop: true }),
			frame("assistantResponseEvent", { content: "after", stopReason: "END_TURN" }),
		);
		const { events, result } = await drain(
			streamKiro(
				model,
				{ messages: [user("order")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		const lifecycle = events
			.filter(event => event.type.startsWith("text_") || event.type.startsWith("toolcall_"))
			.map(event => event.type);
		expect(lifecycle.indexOf("text_end")).toBeLessThan(lifecycle.indexOf("toolcall_start"));
		expect(result.content).toEqual([
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
			{ type: "text", text: "after" },
		]);
	});

	it("rejects malformed tool input instead of substituting empty arguments", async () => {
		const bytes = frame("toolUseEvent", { toolUseId: "t1", name: "read", input: [1, 2], stop: true });
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("bad args")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("MALFORMED_TOOL_INPUT");
		expect(result.content).toEqual([]);
	});

	it("merges every metric envelope within a single frame", async () => {
		const bytes = concat(
			frame("assistantResponseEvent", { content: "ok", stopReason: "END_TURN" }),
			frame("metricsEvent", { usage: { inputTokens: 11 }, metrics: { outputTokens: 5 } }),
		);
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("merge")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		expect(result.usage).toMatchObject({ input: 11, output: 5 });
	});

	it("buffers a signature-only reasoning frame until reasoning text starts", async () => {
		const bytes = concat(
			frame("reasoningContentEvent", { signature: "signed-reasoning" }),
			frame("reasoningContentEvent", { text: "reasoning" }),
			frame("assistantResponseEvent", { content: "answer", stopReason: "END_TURN" }),
		);
		const { events, result } = await drain(
			streamKiro(
				model,
				{ messages: [user("reason")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		expect(events.filter(event => event.type.startsWith("thinking_")).map(event => event.type)).toEqual([
			"thinking_start",
			"thinking_delta",
			"thinking_end",
		]);
		expect(result.content[0]).toEqual({
			type: "thinking",
			thinking: "reasoning",
			thinkingSignature: "signed-reasoning",
		});
	});

	it("falls back to inline thinking and maps token-limit stops", async () => {
		const bytes = concat(
			frame("assistantResponseEvent", { content: "<thinking>inspect</thinking>\n\nanswer" }),
			frame("assistantResponseEvent", { content: " continued", stopReason: "MAX_TOKENS" }),
		);
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("inline")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "inspect" },
			{ type: "text", text: "answer continued" },
		]);
		expect(result.stopReason).toBe("length");
	});

	it("assembles interleaved string deltas, snapshots, and zero-argument tools per ID", async () => {
		const bytes = concat(
			frame("toolUseEvent", { toolUseId: "a", name: "first", input: '{"x":' }),
			frame("toolUseEvent", { toolUseId: "b", name: "second", input: { value: 1 } }),
			frame("toolUseEvent", { toolUseId: "a", input: "1}", stop: true }),
			frame("toolUseEvent", { toolUseId: "b", input: { value: 2 }, stop: true }),
			frame("toolUseEvent", { toolUseId: "c", name: "third", input: "", stop: true }),
			frame("contextUsageEvent", { contextUsagePercentage: 10 }),
		);
		const { events, result } = await drain(
			streamKiro(
				model,
				{ messages: [user("tools")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(3);
		expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(3);
		expect(result.content).toEqual([
			{ type: "toolCall", id: "a", name: "first", arguments: { x: 1 } },
			{ type: "toolCall", id: "b", name: "second", arguments: { value: 2 } },
			{ type: "toolCall", id: "c", name: "third", arguments: {} },
		]);
		expect(result.stopReason).toBe("toolUse");
	});

	it("merges metric aliases per field and rejects reasoning larger than output", async () => {
		const bytes = concat(
			frame("assistantResponseEvent", { content: "ok", stopReason: "END_TURN" }),
			frame("metricsEvent", { metricsEvent: { input_tokens: 8, cache_read_tokens: 3 } }),
			frame("usageEvent", { usageEvent: { outputTokens: 2, cacheWriteTokens: 4, reasoning_tokens: 9 } }),
			frame("metricsEvent", { metrics: { inputTokens: 10 } }),
		);
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("metrics")] },
				{ apiKey: "ksk_test", fetch: async () => eventResponse(bytes) },
			),
		);
		expect(result.usage).toMatchObject({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19 });
		expect(result.usage.reasoningTokens).toBeUndefined();
	});

	it("retries one capacity failure before output and emits only the successful attempt", async () => {
		let calls = 0;
		const waits: number[] = [];
		const fetchImpl: FetchImpl = async (_input, _init) => {
			calls++;
			if (calls === 1) {
				return new Response(JSON.stringify({ __type: "INSUFFICIENT_MODEL_CAPACITY", message: "capacity" }), {
					status: 503,
					headers: { "content-type": "application/x-amz-json-1.0" },
				});
			}
			return eventResponse(normalFrames());
		};
		const { events, result } = await drain(
			streamKiro(
				model,
				{ messages: [user("retry")] },
				{
					apiKey: "ksk_test",
					fetch: fetchImpl,
					providerRetryWait: async delay => {
						waits.push(delay);
					},
				},
			),
		);
		expect(calls).toBe(2);
		expect(waits).toEqual([500]);
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
	});

	it("discards a metadata-only attempt and recovers once without leaking its start event", async () => {
		let calls = 0;
		const fetchImpl: FetchImpl = async (_input, _init) => {
			calls++;
			return calls === 1
				? eventResponse(frame("metadataEvent", { requestId: "discarded" }))
				: eventResponse(normalFrames());
		};
		const { events, result } = await drain(
			streamKiro(
				model,
				{ messages: [user("retry empty")] },
				{
					apiKey: "ksk_test",
					fetch: fetchImpl,
					providerRetryWait: async () => {},
				},
			),
		);
		expect(calls).toBe(2);
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(result.responseId).toBe("fixture-request");
	});

	it("never replays malformed tool input after the tool start became visible", async () => {
		let calls = 0;
		const bytes = frame("toolUseEvent", { toolUseId: "bad", name: "write", input: "{", stop: true });
		const { events, result } = await drain(
			streamKiro(
				model,
				{ messages: [user("bad tool")] },
				{
					apiKey: "ksk_test",
					fetch: async () => {
						calls++;
						return eventResponse(bytes);
					},
				},
			),
		);
		expect(calls).toBe(1);
		expect(events.some(event => event.type === "toolcall_start")).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("malformed JSON input");
	});

	it("returns partial output plus a typed error without replaying a truncated post-output stream", async () => {
		let calls = 0;
		const visible = frame("assistantResponseEvent", { content: "partial" });
		const truncated = frame("metadataEvent", { requestId: "never-complete" }).subarray(0, 10);
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("truncate")] },
				{
					apiKey: "ksk_test",
					fetch: async () => {
						calls++;
						return eventResponse(concat(visible, truncated));
					},
				},
			),
		);
		expect(calls).toBe(1);
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(result.stopReason).toBe("error");
		expect(result.ttft).toBeNumber();
		expect(result.duration).toBeNumber();
	});

	it("propagates auth status without provider-local refresh or replay", async () => {
		let calls = 0;
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("auth")] },
				{
					apiKey: "ksk_test",
					fetch: async () => {
						calls++;
						return new Response(JSON.stringify({ __type: "UNAUTHORIZED", message: "expired" }), { status: 401 });
					},
				},
			),
		);
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
	});

	it("applies the first-event timeout override while fetch is pending", async () => {
		vi.useFakeTimers();
		const fetchStarted = Promise.withResolvers<void>();
		let transportSignal: AbortSignal | null | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			transportSignal = init?.signal;
			fetchStarted.resolve();
			const { promise, reject } = Promise.withResolvers<Response>();
			transportSignal?.addEventListener("abort", () => reject(transportSignal?.reason), { once: true });
			return promise;
		};
		const resultPromise = streamKiro(
			model,
			{ messages: [user("timeout")] },
			{
				apiKey: "ksk_test",
				fetch: fetchImpl,
				streamFirstEventTimeoutMs: 5,
			},
		).result();
		await fetchStarted.promise;
		vi.advanceTimersByTime(5);
		const result = await resultPromise;
		expect(transportSignal?.reason).toHaveProperty("name", "TimeoutError");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
	});

	it("dispatches through the native API and leaves timeout enforcement to the Kiro leaf", async () => {
		vi.useFakeTimers();
		const fetchStarted = Promise.withResolvers<void>();
		let transportSignal: AbortSignal | null | undefined;
		const resultPromise = stream(
			model,
			{ messages: [user("native dispatch")] },
			{
				apiKey: "ksk_test",
				streamFirstEventTimeoutMs: 5,
				fetch: async (_input, init) => {
					transportSignal = init?.signal;
					fetchStarted.resolve();
					const { promise, reject } = Promise.withResolvers<Response>();
					transportSignal?.addEventListener("abort", () => reject(transportSignal?.reason), { once: true });
					return promise;
				},
			},
		).result();
		await fetchStarted.promise;
		vi.advanceTimersByTime(5);
		const result = await resultPromise;
		expect(transportSignal?.reason).toHaveProperty("name", "TimeoutError");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("lazy provider stream");
	});

	it("honors caller cancellation while fetch is pending", async () => {
		const controller = new AbortController();
		const fetchStarted = Promise.withResolvers<void>();
		const fetchImpl: FetchImpl = async (_input, init) => {
			fetchStarted.resolve();
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			return promise;
		};
		const resultPromise = streamKiro(
			model,
			{ messages: [user("abort fetch")] },
			{
				apiKey: "ksk_test",
				signal: controller.signal,
				fetch: fetchImpl,
			},
		).result();
		await fetchStarted.promise;
		controller.abort();
		const result = await resultPromise;
		expect(result.stopReason).toBe("aborted");
	});

	it("cancels the response reader when the caller aborts during streaming", async () => {
		const controller = new AbortController();
		const readStarted = Promise.withResolvers<void>();
		const readerCancelled = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					readStarted.resolve();
				},
				cancel() {
					readerCancelled.resolve();
				},
			},
			{ highWaterMark: 0 },
		);
		const resultPromise = streamKiro(
			model,
			{ messages: [user("abort read")] },
			{
				apiKey: "ksk_test",
				signal: controller.signal,
				fetch: async () => new Response(body, { status: 200 }),
			},
		).result();
		await readStarted.promise;
		controller.abort();
		const result = await resultPromise;
		await readerCancelled.promise;
		expect(result.stopReason).toBe("aborted");
	});

	it("honors cancellation during provider backoff", async () => {
		const controller = new AbortController();
		let calls = 0;
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("abort")] },
				{
					apiKey: "ksk_test",
					signal: controller.signal,
					fetch: async () => {
						calls++;
						return new Response(JSON.stringify({ __type: "INSUFFICIENT_MODEL_CAPACITY" }), { status: 503 });
					},
					providerRetryWait: async (_delay, signal) => {
						controller.abort(new Error("cancelled"));
						throw signal?.reason;
					},
				},
			),
		);
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("aborted");
	});

	it("maps decoded EventStream exceptions without retrying or exposing raw payloads", async () => {
		const exception = Uint8Array.fromBase64(eventStreamFixture.sequences.exception.base64);
		let calls = 0;
		let waits = 0;
		const { result } = await drain(
			streamKiro(
				model,
				{ messages: [user("exception")] },
				{
					apiKey: "ksk_test",
					fetch: async () => {
						calls++;
						return eventResponse(exception);
					},
					providerRetryWait: async () => {
						waits++;
					},
				},
			),
		);
		expect(calls).toBe(1);
		expect(waits).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("validationException: <sanitized-provider-message>");
	});
});

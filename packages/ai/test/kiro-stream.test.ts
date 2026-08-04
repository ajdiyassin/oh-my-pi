import { describe, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { crc32, type EventStreamMessage } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import {
	type KiroRequest,
	type KiroStreamCredential,
	normalizeKiroFrame,
	streamKiro,
} from "@oh-my-pi/pi-ai/providers/kiro/index";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const TEST_PROFILE: KiroStreamCredential["profileArn"] =
	"arn:aws:codewhisperer:us-east-1:123456789012:profile/test-profile";
const EU_PROFILE = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/eu-profile";
const EU_RUNTIME_ENDPOINT = "https://runtime.eu-central-1.kiro.dev/";
const TEST_CONTEXT: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

function createModel(baseUrl = "https://runtime.us-east-1.kiro.dev/"): Model<"kiro-api"> {
	return buildModel({
		id: "kiro-stream-test-model",
		name: "Kiro stream test model",
		api: "kiro-api",
		provider: "kiro",
		baseUrl,
		reasoning: true,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.High],
			defaultLevel: Effort.Low,
			supportsDisplay: true,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 2_048,
	});
}

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const output = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(output.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	output.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	output.set(valueBytes, offset);
	return output;
}

function encodeEventFrame(eventType: string, payload: unknown, messageType = "event"): Uint8Array {
	const headers = [encodeStringHeader(":message-type", messageType), encodeStringHeader(":event-type", eventType)];
	const headerLength = headers.reduce((total, header) => total + header.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let headerOffset = 0;
	for (const header of headers) {
		headerBytes.set(header, headerOffset);
		headerOffset += header.length;
	}
	const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
	const totalLength = 4 + 4 + 4 + headerLength + payloadBytes.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headerBytes, 12);
	frame.set(payloadBytes, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

function concatFrames(frames: readonly Uint8Array[]): Uint8Array {
	const totalLength = frames.reduce((total, frame) => total + frame.length, 0);
	const output = new Uint8Array(totalLength);
	let offset = 0;
	for (const frame of frames) {
		output.set(frame, offset);
		offset += frame.length;
	}
	return output;
}

function streamFrom(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	});
}

function responseForEvents(events: readonly [string, unknown][]): Response {
	const bytes = concatFrames(events.map(([eventType, payload]) => encodeEventFrame(eventType, payload)));
	const split = Math.min(7, bytes.length);
	return new Response(streamFrom([bytes.subarray(0, split), bytes.subarray(split)]), {
		status: 200,
		headers: { "content-type": "application/vnd.amazon.eventstream" },
	});
}

function eventMessage(eventType: string, payload: unknown, messageType = "event"): EventStreamMessage {
	return {
		headers: { ":message-type": messageType, ":event-type": eventType },
		payload: new TextEncoder().encode(JSON.stringify(payload)),
	};
}

function eventPayload(result: unknown): KiroRequest {
	return result as KiroRequest;
}

describe("Kiro event normalization", () => {
	test("normalizes metadata, reasoning, tools, context usage, and metric aliases", () => {
		expect(normalizeKiroFrame(eventMessage("initial-response", { requestId: "req-1" }))).toEqual({
			type: "metadata",
			requestId: "req-1",
		});
		expect(
			normalizeKiroFrame(eventMessage("reasoningContentEvent", { text: "thinking", signature: "sig-1" })),
		).toEqual({
			type: "reasoning",
			text: "thinking",
			signature: "sig-1",
		});
		expect(
			normalizeKiroFrame(
				eventMessage("toolUseEvent", { toolUseId: "tool-1", name: "lookup", input: "{}", stop: true }),
			),
		).toEqual({
			type: "tool",
			toolUseId: "tool-1",
			name: "lookup",
			input: "{}",
			stop: true,
		});
		expect(normalizeKiroFrame(eventMessage("contextUsageEvent", { contextUsagePercentage: 42 }))).toEqual({
			type: "contextUsage",
			percentage: 42,
		});
		expect(
			normalizeKiroFrame(eventMessage("metricsEvent", { input_tokens: 8, outputTokens: 5, cachedTokens: 2 })),
		).toEqual({
			type: "usage",
			usage: { inputTokens: 8, outputTokens: 5, cacheReadTokens: 2 },
		});
	});

	test("ignores unknown events and rejects malformed semantic frames", () => {
		expect(normalizeKiroFrame(eventMessage("futureKiroEvent", { ignored: true }))).toEqual({ type: "ignored" });
		expect(() => normalizeKiroFrame(eventMessage("assistantResponseEvent", { content: 42 }))).toThrow(
			/MALFORMED_ASSISTANT_EVENT/,
		);
		expect(() =>
			normalizeKiroFrame({
				headers: {
					":message-type": "exception",
					":exception-type": "ThrottlingException",
				},
				payload: new TextEncoder().encode(JSON.stringify({ message: "slow down" })),
			}),
		).toThrow(/ThrottlingException/);
	});
});

describe("Kiro stream transport", () => {
	test("emits ordered reasoning, text, tool-call, usage, and terminal events", async () => {
		const events: Array<[string, unknown]> = [
			["initial-response", { requestId: "req-1" }],
			["reasoningContentEvent", { text: "thinking", signature: "sig-1" }],
			["assistantResponseEvent", { content: "before tool" }],
			["toolUseEvent", { toolUseId: "server/tool", name: "lookup", input: '{"path":' }],
			["toolUseEvent", { toolUseId: "server/tool", input: '"README.md"}', stop: true }],
			["metadataEvent", { stopReason: "TOOL_USE" }],
			["usageEvent", { inputTokens: 12, outputTokens: 7, reasoningTokens: 3 }],
		];
		const fetch: FetchImpl = async () => responseForEvents(events);
		const stream = streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: JSON.stringify({ token: "kiro-token", profileArn: TEST_PROFILE }),
			fetch,
		});
		const emitted: string[] = [];
		for await (const event of stream) emitted.push(event.type);
		const result = await stream.result();

		expect(emitted).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content.map(block => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(result.content.find(block => block.type === "thinking")).toMatchObject({
			thinking: "thinking",
			thinkingSignature: "sig-1",
		});
		expect(result.content.find(block => block.type === "toolCall")).toMatchObject({
			name: "lookup",
			arguments: { path: "README.md" },
		});
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(7);
		expect(result.usage.reasoningTokens).toBe(3);
	});

	test("retries one pre-output capacity response", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const fetch: FetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) {
				return Response.json(
					{ code: "INSUFFICIENT_MODEL_CAPACITY", message: "try another model" },
					{ status: 429 },
				);
			}
			return responseForEvents([["assistantResponseEvent", { content: "recovered" }]]);
		};
		const result = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch,
			providerRetryWait: async delay => {
				waits.push(delay);
			},
		}).result();

		expect(attempts).toBe(2);
		expect(waits).toEqual([500]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "recovered" });
	});

	test("maps context overflow responses and validates active endpoint routing before fetch", async () => {
		let fetchCalls = 0;
		const contextFetch: FetchImpl = async () => {
			fetchCalls += 1;
			return Response.json(
				{ __type: "ValidationException", message: "input exceeds the context window" },
				{ status: 400 },
			);
		};
		const overflow = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch: contextFetch,
		}).result();
		expect(overflow.stopReason).toBe("error");
		expect(overflow.errorStatus).toBe(400);
		expect(AIError.is(overflow.errorId, AIError.Flag.ContextOverflow)).toBe(true);
		expect(overflow.errorMessage).toContain("exceeds the context window");
		expect(fetchCalls).toBe(1);

		const rejectingFetch: FetchImpl = async () => {
			throw new Error("fetch should not run for invalid routing");
		};
		const invalidEndpoint = await streamKiro(createModel("https://api.example.com/"), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch: rejectingFetch,
		}).result();
		expect(invalidEndpoint.errorMessage).toContain("Invalid Kiro runtime endpoint");

		const malformedCredential = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: JSON.stringify({ token: "kiro-token", apiEndpoint: 42 }),
			fetch: rejectingFetch,
		}).result();
		expect(malformedCredential.errorMessage).toContain("Kiro credential projection is invalid");

		const profileRequests: string[] = [];
		const profileFetch: FetchImpl = async input => {
			profileRequests.push(String(input));
			return responseForEvents([["assistantResponseEvent", { content: "profile-routed" }]]);
		};
		const activeProfile = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: JSON.stringify({
				token: "kiro-token",
				profileArn: EU_PROFILE,
			}),
			fetch: profileFetch,
		}).result();
		expect(activeProfile.stopReason).toBe("stop");
		expect(profileRequests).toEqual([EU_RUNTIME_ENDPOINT]);
	});

	test("reports transport and semantic first-visible-output timeouts distinctly from caller abort", async () => {
		const timeoutFetch: FetchImpl = async (_input, init) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			const signal = init?.signal;
			if (!signal) throw new Error("timeout test did not receive a signal");
			const rejectOnAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
			signal.addEventListener("abort", rejectOnAbort, { once: true });
			if (signal.aborted) rejectOnAbort();
			return promise;
		};
		const timedOut = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch: timeoutFetch,
			streamFirstEventTimeoutMs: 20,
		}).result();
		expect(timedOut.stopReason).toBe("error");
		expect(timedOut.errorMessage).toMatch(/timed out|timeout/i);

		const blockedBody = Promise.withResolvers<void>();
		const metadataBytes = concatFrames([encodeEventFrame("initial-response", { requestId: "metadata-only" })]);
		const bodyResponse = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(metadataBytes);
				},
				pull() {
					return blockedBody.promise;
				},
				cancel() {
					blockedBody.resolve();
				},
			}),
			{ status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
		);
		let bodyFetchCalls = 0;
		const bodyTimeout = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch: async () => {
				bodyFetchCalls += 1;
				return bodyResponse;
			},
			streamFirstEventTimeoutMs: 20,
			streamIdleTimeoutMs: 1_000,
			providerRetryWait: async () => {
				throw new Error("semantic timeout must not retry");
			},
		}).result();
		expect(bodyTimeout.stopReason).toBe("error");
		expect(bodyTimeout.errorMessage).toContain("first visible output");
		expect(AIError.is(bodyTimeout.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(bodyFetchCalls).toBe(1);

		const controller = new AbortController();
		controller.abort(new DOMException("caller cancelled", "AbortError"));
		const aborted = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch: timeoutFetch,
			signal: controller.signal,
		}).result();
		expect(aborted.stopReason).toBe("aborted");
	});

	test("retries once after a clean no-output response before visible output", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const fetch: FetchImpl = async () => {
			attempts += 1;
			return attempts === 1
				? responseForEvents([["initial-response", { requestId: "no-output" }]])
				: responseForEvents([["assistantResponseEvent", { content: "recovered" }]]);
		};
		const result = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch,
			providerRetryWait: async delay => {
				waits.push(delay);
			},
		}).result();

		expect(attempts).toBe(2);
		expect(waits).toEqual([500]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "recovered" });
	});

	test("caps clean no-output recovery after one retry", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const fetch: FetchImpl = async () => {
			attempts += 1;
			return responseForEvents([["initial-response", { requestId: `no-output-${attempts}` }]]);
		};
		const result = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch,
			providerRetryWait: async delay => {
				waits.push(delay);
			},
		}).result();

		expect(attempts).toBe(2);
		expect(waits).toEqual([500]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ended without visible output");
	});

	test("does not replay a stream failure after visible output", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const fetch: FetchImpl = async () => {
			attempts += 1;
			const body = concatFrames([
				encodeEventFrame("assistantResponseEvent", { content: "visible before failure" }),
				new Uint8Array([0, 0, 0, 20]),
			]);
			return new Response(streamFrom([body]), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		};
		const result = await streamKiro(createModel(), TEST_CONTEXT, {
			apiKey: "kiro-token",
			fetch,
			providerRetryWait: async delay => {
				waits.push(delay);
			},
		}).result();

		expect(attempts).toBe(1);
		expect(waits).toEqual([]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("truncated message");
		expect(result.content).toContainEqual({ type: "text", text: "visible before failure" });
	});

	test("dispatches through the public simple-stream API with Kiro headers and request fields", async () => {
		let requestBody: unknown;
		let requestHeaders: Headers | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			requestHeaders = new Headers(init?.headers);
			return responseForEvents([["assistantResponseEvent", { content: "public dispatch" }]]);
		};
		const result = await streamSimple(createModel(), TEST_CONTEXT, {
			apiKey: JSON.stringify({ token: "kiro-token", profileArn: TEST_PROFILE }),
			fetch,
			reasoning: Effort.High,
			maxTokens: 128,
		}).result();
		const payload = eventPayload(requestBody);

		expect(result.stopReason).toBe("stop");
		expect(payload.profileArn).toBe(TEST_PROFILE);
		expect(payload.additionalModelRequestFields).toMatchObject({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
			max_tokens: 128,
		});
		expect(requestHeaders?.get("x-amz-target")).toBe("KiroRuntimeService.GenerateAssistantResponse");
		expect(requestHeaders?.get("authorization")).toBe("Bearer kiro-token");
		expect(requestHeaders?.get("accept")).toBe("application/vnd.amazon.eventstream");
	});

	test("routes inference through the active credential instead of stale model metadata", async () => {
		const requestedUrls: string[] = [];
		const fetch: FetchImpl = async input => {
			requestedUrls.push(String(input));
			return responseForEvents([["assistantResponseEvent", { content: "routed" }]]);
		};
		const staleModel = createModel();

		const oauthResult = await streamKiro(staleModel, TEST_CONTEXT, {
			apiKey: JSON.stringify({ token: "oauth-token", profileArn: EU_PROFILE }),
			fetch,
		}).result();
		const apiKeyResult = await streamKiro(staleModel, TEST_CONTEXT, {
			apiKey: JSON.stringify({ token: "api-key", apiEndpoint: EU_RUNTIME_ENDPOINT }),
			fetch,
		}).result();

		const previousRegion = Bun.env.KIRO_API_REGION;
		try {
			Bun.env.KIRO_API_REGION = "eu-central-1";
			const envResult = await streamKiro(staleModel, TEST_CONTEXT, { apiKey: "env-token", fetch }).result();
			expect(envResult.stopReason).toBe("stop");
		} finally {
			if (previousRegion === undefined) delete Bun.env.KIRO_API_REGION;
			else Bun.env.KIRO_API_REGION = previousRegion;
		}

		expect(oauthResult.stopReason).toBe("stop");
		expect(apiKeyResult.stopReason).toBe("stop");
		expect(requestedUrls).toEqual([EU_RUNTIME_ENDPOINT, EU_RUNTIME_ENDPOINT, EU_RUNTIME_ENDPOINT]);
	});
});

import { describe, expect, test } from "bun:test";
import { decodeEventStream } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import authProtocol from "./fixtures/kiro/auth-protocol.json" with { type: "json" };
import eventStreamFixture from "./fixtures/kiro/eventstream.json" with { type: "json" };
import runtimeProtocol from "./fixtures/kiro/runtime-protocol.json" with { type: "json" };

interface DecodedFixtureFrame {
	headers: Record<string, string>;
	payload: unknown;
}

function fixtureStream(base64: string, chunkSize: number): ReadableStream<Uint8Array> {
	const bytes = Uint8Array.fromBase64(base64);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const end = Math.min(offset + chunkSize, bytes.length);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
	});
}

async function decodeFixture(base64: string, chunkSize = 7): Promise<DecodedFixtureFrame[]> {
	const frames: DecodedFixtureFrame[] = [];
	for await (const message of decodeEventStream(fixtureStream(base64, chunkSize))) {
		frames.push({
			headers: message.headers,
			payload: JSON.parse(new TextDecoder().decode(message.payload)) as unknown,
		});
	}
	return frames;
}

const forbiddenFixturePatterns: Array<[string, RegExp]> = [
	["live bearer/API key", /(?:ksk_|Bearer\s+)[A-Za-z0-9._~+/-]{8,}/i],
	["AWS profile ARN", /arn:aws(?:-us-gov)?:codewhisperer:[^\s"']+/i],
	["email address", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
	["Windows user path", /[A-Z]:\\Users\\[^\\\s]+/i],
	["Unix home path", /\/(?:home|Users)\/[^/\s]+/],
	["JWT", /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/],
];

const forbiddenSensitiveKeys = new Set([
	"access_token",
	"accessToken",
	"refresh_token",
	"refreshToken",
	"client_secret",
	"clientSecret",
	"device_code",
	"deviceCode",
	"user_code",
	"userCode",
	"code_verifier",
	"codeVerifier",
	"code_challenge",
	"codeChallenge",
	"authorization",
	"cookie",
	"email",
	"accountId",
	"profileArn",
]);

function assertSanitized(value: unknown, path = "fixture"): void {
	if (typeof value === "string") {
		for (const [description, pattern] of forbiddenFixturePatterns) {
			expect(pattern.test(value), `${path} contains ${description}`).toBe(false);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) assertSanitized(item, `${path}[${index}]`);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (forbiddenSensitiveKeys.has(key) && typeof child === "string") {
			expect(child, `${path}.${key} must use a semantic marker`).toMatch(/^<[a-z0-9-]+>$/);
		}
		assertSanitized(child, `${path}.${key}`);
	}
}

describe("Kiro Phase 0 protocol fixtures", () => {
	test("normal captured semantics replay through the production EventStream decoder", async () => {
		const sequence = eventStreamFixture.sequences.normal;
		const frames = await decodeFixture(sequence.base64, 1);
		expect(frames).toHaveLength(sequence.frameCount);
		expect(frames.map(frame => frame.headers[":event-type"])).toEqual(sequence.eventTypes);
		expect(frames.every(frame => frame.headers[":message-type"] === "event")).toBe(true);
	});

	test("metrics semantics replay as distinct CRC-valid frames", async () => {
		const sequence = eventStreamFixture.sequences.metrics;
		const frames = await decodeFixture(sequence.base64);
		expect(frames).toHaveLength(sequence.frameCount);
		expect(frames.map(frame => frame.headers[":event-type"])).toEqual(sequence.eventTypes);
		expect(frames.at(-1)?.payload).toEqual({
			inputTokens: 10,
			outputTokens: 4,
			cacheReadTokens: 2,
			cacheCreationTokens: 1,
			reasoningTokens: 1,
		});
	});

	test("synthetic exception frame preserves typed EventStream error headers", async () => {
		const sequence = eventStreamFixture.sequences.exception;
		const frames = await decodeFixture(sequence.base64, 3);
		expect(frames).toHaveLength(sequence.frameCount);
		expect(frames[0].headers[":message-type"]).toBe(sequence.messageType);
		expect(frames[0].headers[":exception-type"]).toBe(sequence.exceptionType);
		expect(frames[0].payload).toEqual({
			code: "REQUEST_BODY_INVALID",
			message: "<sanitized-provider-message>",
			requestId: "fixture-request",
		});
	});

	test("retained contracts distinguish API-key and OAuth profile scope", () => {
		const apiKeySuccess = authProtocol.cases.find(item => item.name === "api_key_model_discovery_us_east_success");
		const apiKeyFailure = authProtocol.cases.find(
			item => item.name === "api_key_model_discovery_eu_central_typed_failure",
		);
		expect(apiKeySuccess).toBeDefined();
		expect(apiKeyFailure).toBeDefined();
		if (!apiKeySuccess?.request || !apiKeySuccess.response || !apiKeyFailure?.request || !apiKeyFailure.response)
			throw new Error("API-key proof cases are incomplete");
		expect(apiKeySuccess.request.jsonFields).toEqual({ origin: "KIRO_CLI" });
		expect(apiKeySuccess.request.forbiddenFields).toContain("profileArn");
		expect(apiKeySuccess.response.status).toBe(200);
		expect(apiKeyFailure.request.jsonFields).toEqual({ origin: "KIRO_CLI" });
		expect(apiKeyFailure.request.forbiddenFields).toContain("profileArn");
		expect(apiKeyFailure.response.status).toBe(400);
		expect(runtimeProtocol.contracts.models.apiKeyRequest).toEqual({ origin: "KIRO_CLI" });
		expect(runtimeProtocol.contracts.models.oauthRequest).toEqual({
			origin: "KIRO_CLI",
			profileArn: "<profile-arn>",
		});
		expect(runtimeProtocol.contracts.runtimeRequests.target).toBe(
			"AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
		);
	});

	test("retained error evidence separates captured HTTP JSON from synthetic EventStream exceptions", () => {
		expect(runtimeProtocol.contracts.httpErrors.requestBodyInvalid.status).toBe(400);
		expect(runtimeProtocol.contracts.httpErrors.requestBodyInvalid.body.__type).toBe("REQUEST_BODY_INVALID");
		expect(eventStreamFixture.sequences.exception.messageType).toBe("exception");
		expect(eventStreamFixture.sequences.exception.provenance).toBe("synthetic-decoder-oracle");
	});

	test("fixtures contain no captured credentials, identity, content, or machine paths", () => {
		assertSanitized(authProtocol, "auth-protocol.json");
		assertSanitized(runtimeProtocol, "runtime-protocol.json");
		assertSanitized(eventStreamFixture, "eventstream.json");
	});
});

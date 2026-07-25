import { describe, expect, test } from "bun:test";
import { EventStreamFrameError } from "@oh-my-pi/pi-ai/error/aws";
import {
	crc32,
	decodeEventStream,
	decodeMessage,
	MAX_BUFFER_SIZE,
	MAX_FRAME_SIZE,
	MAX_HEADERS_SIZE,
} from "@oh-my-pi/pi-ai/providers/aws-eventstream";

// ---- Frame builder (mirrors @smithy/eventstream-codec but in-process so the
// test owns the bytes). The decoder is the production code; we encode here for
// fixture generation only.

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	if (nameBytes.length > 255) throw new Error("name too long");
	const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buf.buffer);
	let p = 0;
	view.setUint8(p, nameBytes.length);
	p += 1;
	buf.set(nameBytes, p);
	p += nameBytes.length;
	view.setUint8(p, 7); // string type
	p += 1;
	view.setUint16(p, valueBytes.length, false);
	p += 2;
	buf.set(valueBytes, p);
	return buf;
}

function sealFrame(headerBytes: Uint8Array, payload: Uint8Array): Uint8Array {
	const headerLen = headerBytes.length;
	const total = 4 + 4 + 4 + headerLen + payload.length + 4;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headerLen, false);
	view.setUint32(8, crc32(out.subarray(0, 8)), false);
	out.set(headerBytes, 12);
	out.set(payload, 12 + headerLen);
	view.setUint32(total - 4, crc32(out.subarray(0, total - 4)), false);
	return out;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLen = headerChunks.reduce((s, c) => s + c.length, 0);
	const headerBytes = new Uint8Array(headerLen);
	let off = 0;
	for (const c of headerChunks) {
		headerBytes.set(c, off);
		off += c.length;
	}
	return sealFrame(headerBytes, payload);
}

/** Prelude only — used to claim lengths without buffering a full frame. */
function encodePrelude(total: number, headersLen: number): Uint8Array {
	const out = new Uint8Array(12);
	const view = new DataView(out.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headersLen, false);
	view.setUint32(8, crc32(out.subarray(0, 8)), false);
	return out;
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

async function collect(
	stream: ReadableStream<Uint8Array>,
): Promise<Array<{ headers: Record<string, string>; text: string }>> {
	const out: Array<{ headers: Record<string, string>; text: string }> = [];
	for await (const msg of decodeEventStream(stream)) {
		out.push({ headers: msg.headers, text: new TextDecoder().decode(msg.payload) });
	}
	return out;
}

function expectFrameError(fn: () => unknown, pattern: RegExp): void {
	expect(fn).toThrow(EventStreamFrameError);
	try {
		fn();
	} catch (e) {
		expect(String(e)).toMatch(pattern);
	}
}

async function expectStreamError(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<void> {
	let threw: unknown;
	try {
		await collect(stream);
	} catch (e) {
		threw = e;
	}
	expect(threw).toBeInstanceOf(EventStreamFrameError);
	expect(String(threw)).toMatch(pattern);
}

describe("aws-eventstream", () => {
	test("CRC32 matches known vectors", () => {
		// Standard CRC32 of "123456789" = 0xCBF43926 (zlib/IEEE).
		const bytes = new TextEncoder().encode("123456789");
		expect(crc32(bytes)).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
	});

	test("decodes a single full-message frame", async () => {
		const payload = new TextEncoder().encode('{"messageStart":{"role":"assistant"}}');
		const frame = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStart", ":content-type": "application/json" },
			payload,
		);
		const decoded = decodeMessage(frame);
		expect(decoded.headers[":event-type"]).toBe("messageStart");
		expect(new TextDecoder().decode(decoded.payload)).toBe('{"messageStart":{"role":"assistant"}}');

		const collected = await collect(streamFrom([frame]));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":message-type"]).toBe("event");
	});

	test("stitches a frame split across two chunks", async () => {
		const payload = new TextEncoder().encode('{"contentBlockDelta":{"delta":{"text":"hi"}}}');
		const frame = encodeFrame({ ":message-type": "event", ":event-type": "contentBlockDelta" }, payload);
		const mid = Math.floor(frame.length / 2);
		const chunks = [frame.subarray(0, mid), frame.subarray(mid)];
		const collected = await collect(streamFrom(chunks.map(c => new Uint8Array(c))));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":event-type"]).toBe("contentBlockDelta");
		expect(collected[0].text).toContain('"hi"');
	});

	test("stitches a frame split on every byte", async () => {
		const frame = encodeFrame(
			{ ":message-type": "event", ":event-type": "contentBlockDelta" },
			new TextEncoder().encode('{"x":1}'),
		);
		const chunks = Array.from({ length: frame.length }, (_, i) => new Uint8Array([frame[i]]));
		const collected = await collect(streamFrom(chunks));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":event-type"]).toBe("contentBlockDelta");
		expect(collected[0].text).toBe('{"x":1}');
	});

	test("decodes multiple messages packed into one chunk", async () => {
		const a = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStart" },
			new TextEncoder().encode('{"role":"assistant"}'),
		);
		const b = encodeFrame(
			{ ":message-type": "event", ":event-type": "contentBlockDelta" },
			new TextEncoder().encode('{"x":1}'),
		);
		const c = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStop" },
			new TextEncoder().encode('{"stopReason":"end_turn"}'),
		);
		const merged = new Uint8Array(a.length + b.length + c.length);
		merged.set(a, 0);
		merged.set(b, a.length);
		merged.set(c, a.length + b.length);

		const collected = await collect(streamFrom([merged]));
		expect(collected.map(x => x.headers[":event-type"])).toEqual([
			"messageStart",
			"contentBlockDelta",
			"messageStop",
		]);
	});

	test("accepts a large chunk containing multiple complete bounded frames", async () => {
		const payload = new Uint8Array(13 * 1024 * 1024);
		const first = encodeFrame({ ":event-type": "first" }, payload);
		const second = encodeFrame({ ":event-type": "second" }, payload);
		const merged = new Uint8Array(first.length + second.length);
		merged.set(first, 0);
		merged.set(second, first.length);
		expect(merged.length).toBeGreaterThan(MAX_BUFFER_SIZE);

		const collected = await collect(streamFrom([merged]));
		expect(collected.map(message => message.headers[":event-type"])).toEqual(["first", "second"]);
	});

	test("decodes multiple frames with arbitrary chunk boundaries", async () => {
		const frames = [
			encodeFrame({ ":event-type": "a" }, new TextEncoder().encode("1")),
			encodeFrame({ ":event-type": "b" }, new TextEncoder().encode("2")),
			encodeFrame({ ":event-type": "c" }, new TextEncoder().encode("3")),
		];
		const merged = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
		let off = 0;
		for (const f of frames) {
			merged.set(f, off);
			off += f.length;
		}
		// Uneven splits that cut inside frames and across boundaries.
		const cuts = [3, 11, merged.length - 5, merged.length];
		const chunks: Uint8Array[] = [];
		let prev = 0;
		for (const cut of cuts) {
			chunks.push(new Uint8Array(merged.subarray(prev, cut)));
			prev = cut;
		}
		const collected = await collect(streamFrom(chunks));
		expect(collected.map(x => x.headers[":event-type"])).toEqual(["a", "b", "c"]);
		expect(collected.map(x => x.text)).toEqual(["1", "2", "3"]);
	});

	test("surfaces exception event headers and payload", async () => {
		const payload = new TextEncoder().encode('{"message":"input too long"}');
		const frame = encodeFrame(
			{
				":message-type": "exception",
				":exception-type": "validationException",
				":content-type": "application/json",
			},
			payload,
		);
		const collected = await collect(streamFrom([frame]));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":message-type"]).toBe("exception");
		expect(collected[0].headers[":exception-type"]).toBe("validationException");
		expect(collected[0].text).toContain("input too long");
	});

	test("throws on prelude CRC mismatch", () => {
		const frame = encodeFrame({ ":event-type": "x" }, new Uint8Array(0));
		frame[8] ^= 0xff; // flip a byte in the prelude CRC
		expectFrameError(() => decodeMessage(frame), /prelude CRC/);
	});

	test("throws on message CRC mismatch", () => {
		const frame = encodeFrame({ ":event-type": "x" }, new TextEncoder().encode("{}"));
		frame[frame.length - 1] ^= 0xff;
		expectFrameError(() => decodeMessage(frame), /message CRC/);
	});

	test("throws when header name length overruns the header block", () => {
		// name_len=5 but only 2 name bytes remain before end of headers.
		const headers = Uint8Array.of(5, 0x61, 0x62);
		const frame = sealFrame(headers, new Uint8Array(0));
		expectFrameError(() => decodeMessage(frame), /header name/);
	});

	test("throws when string header value length overruns the header block", () => {
		// name "x", type string, value_len=10, but only 1 value byte present.
		const headers = Uint8Array.of(
			1,
			0x78, // name "x"
			7, // string
			0,
			10, // value length 10
			0x21, // one byte of value
		);
		const frame = sealFrame(headers, new Uint8Array(0));
		expectFrameError(() => decodeMessage(frame), /header value/);
	});

	test("throws when fixed-width header value is truncated", () => {
		// name "n", type int32, only 2 of 4 value bytes.
		const headers = Uint8Array.of(1, 0x6e, 4, 0x00, 0x01);
		const frame = sealFrame(headers, new Uint8Array(0));
		expectFrameError(() => decodeMessage(frame), /header value/);
	});

	test("throws when headers length does not fit in the frame", () => {
		const frame = encodeFrame({ ":event-type": "x" }, new Uint8Array(0));
		const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		view.setUint32(4, frame.length, false); // impossibly large headersLen
		view.setUint32(8, crc32(frame.subarray(0, 8)), false);
		// Fix message CRC over the mutated prelude+body so CRC isn't the first failure.
		view.setUint32(frame.length - 4, crc32(frame.subarray(0, frame.length - 4)), false);
		expectFrameError(() => decodeMessage(frame), /headers length|header block/);
	});

	test("rejects invalid UTF-8 in header names when TextDecoder fatal mode is available", () => {
		let fatalSupported = false;
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff]));
		} catch {
			fatalSupported = true;
		}
		if (!fatalSupported) return;

		const headers = Uint8Array.of(1, 0xff, 0); // name byte invalid UTF-8, bool true
		const frame = sealFrame(headers, new Uint8Array(0));
		expectFrameError(() => decodeMessage(frame), /utf-8|UTF-8|invalid/i);
	});

	test("rejects oversized frames before buffering the body", async () => {
		const prelude = encodePrelude(MAX_FRAME_SIZE + 1, 0);
		await expectStreamError(streamFrom([prelude]), /frame|total length|oversized/i);
	});

	test("rejects oversized header blocks before buffering the body", async () => {
		const total = 16 + MAX_HEADERS_SIZE + 1;
		const prelude = encodePrelude(total, MAX_HEADERS_SIZE + 1);
		await expectStreamError(streamFrom([prelude]), /headers length|header/i);
	});

	test("rejects a malformed length before applying the retained-buffer bound", async () => {
		// Once four bytes are available, the declared frame length is validated first.
		const chunk = new Uint8Array(MAX_BUFFER_SIZE + 1);
		await expectStreamError(streamFrom([chunk]), /below minimum/i);
	});

	test("throws on truncated message at end of stream", async () => {
		const frame = encodeFrame({ ":event-type": "x" }, new TextEncoder().encode("{}"));
		const partial = frame.subarray(0, Math.max(4, frame.length - 3));
		await expectStreamError(streamFrom([new Uint8Array(partial)]), /truncated/);
	});

	test("cancels the underlying reader when the consumer stops early", async () => {
		let cancelled = false;
		const frame = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStart" },
			new TextEncoder().encode("{}"),
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame);
				// Leave the stream open so cancel (not close) is observable.
			},
			cancel() {
				cancelled = true;
			},
		});

		const iter = decodeEventStream(stream);
		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(first.value?.headers[":event-type"]).toBe("messageStart");
		await iter.return?.(undefined);
		expect(cancelled).toBe(true);
	});

	test("exports shared frame/header/buffer bounds", () => {
		expect(MAX_FRAME_SIZE).toBe(24 * 1024 * 1024);
		expect(MAX_HEADERS_SIZE).toBe(128 * 1024);
		expect(MAX_BUFFER_SIZE).toBe(25 * 1024 * 1024);
		expect(MAX_BUFFER_SIZE).toBeGreaterThan(MAX_FRAME_SIZE);
		expect(MAX_HEADERS_SIZE).toBeLessThan(MAX_FRAME_SIZE);
	});
});

/**
 * `application/vnd.amazon.eventstream` decoder.
 *
 * Wire format (all integers big-endian):
 *
 *   [total length     u32]
 *   [headers length   u32]
 *   [prelude CRC32    u32]   <- CRC over the first 8 bytes
 *   [headers          headers_length]
 *   [payload          total_length - headers_length - 16]
 *   [message CRC32    u32]   <- CRC over the entire message minus the trailing 4 bytes
 *
 * Headers: a sequence of `[name_len u8][name utf8][value_type u8][value …]`.
 * We only need the typed values Bedrock emits (boolean true/false, byte, short,
 * integer, long, byte-array, string, timestamp, uuid). All are surfaced as
 * strings for ease of consumption — Bedrock only sets string-valued headers in
 * practice (`:event-type`, `:message-type`, `:content-type`, `:exception-type`).
 */

import * as AIError from "../error";

const PRELUDE_LEN = 8;
const PRELUDE_CRC_LEN = 4;
const MESSAGE_CRC_LEN = 4;
const HEADER_BLOCK_OFFSET = PRELUDE_LEN + PRELUDE_CRC_LEN;
const MIN_MESSAGE_LEN = HEADER_BLOCK_OFFSET + MESSAGE_CRC_LEN;

/** Maximum accepted frame size (prelude + headers + payload + CRCs). */
export const MAX_FRAME_SIZE = 24 * 1024 * 1024;
/** Maximum accepted header-block size within a frame. */
export const MAX_HEADERS_SIZE = 128 * 1024;
/** Maximum bytes retained while assembling the next frame. */
export const MAX_BUFFER_SIZE = 25 * 1024 * 1024;

export interface EventStreamMessage {
	/** Lower-cased copy is *not* applied — Bedrock uses casing like `:event-type` verbatim. */
	headers: Record<string, string>;
	payload: Uint8Array;
}

/** CRC32 (IEEE / zlib polynomial 0xEDB88320), matches `@aws-crypto/crc32`. */
export function crc32(bytes: Uint8Array): number {
	return Bun.hash.crc32(bytes) >>> 0;
}

/** Validate prelude lengths shared by one-shot and streaming decode paths. */
function assertFrameLengths(total: number, headersLen: number): void {
	if (!Number.isFinite(total) || total < MIN_MESSAGE_LEN) {
		throw new AIError.EventStreamFrameError(`total length ${total} below minimum`);
	}
	if (total > MAX_FRAME_SIZE) {
		throw new AIError.EventStreamFrameError(`oversized frame (${total} > ${MAX_FRAME_SIZE})`);
	}
	if (!Number.isFinite(headersLen) || headersLen < 0) {
		throw new AIError.EventStreamFrameError(`invalid headers length ${headersLen}`);
	}
	if (headersLen > MAX_HEADERS_SIZE) {
		throw new AIError.EventStreamFrameError(`headers length ${headersLen} exceeds limit ${MAX_HEADERS_SIZE}`);
	}
	if (headersLen > total - MIN_MESSAGE_LEN) {
		throw new AIError.EventStreamFrameError(`header block length ${headersLen} does not fit in frame ${total}`);
	}
}

/**
 * Decode a single, fully buffered eventstream message. Throws if the framing is
 * malformed or either CRC mismatches. Used by both `decodeEventStream` (the
 * streaming entry point) and the unit tests, which exercise it with hand-built
 * frames.
 */
export function decodeMessage(frame: Uint8Array): EventStreamMessage {
	if (frame.length < MIN_MESSAGE_LEN) throw new AIError.EventStreamFrameError("frame too short");
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const total = view.getUint32(0, false);
	const headersLen = view.getUint32(4, false);
	assertFrameLengths(total, headersLen);
	if (total !== frame.length)
		throw new AIError.EventStreamFrameError(`framed length ${total} != buffer ${frame.length}`);
	const preludeCrc = view.getUint32(8, false);
	const computedPreludeCrc = crc32(frame.subarray(0, PRELUDE_LEN));
	if (computedPreludeCrc !== preludeCrc) throw new AIError.EventStreamFrameError("prelude CRC mismatch");
	const msgCrc = view.getUint32(total - MESSAGE_CRC_LEN, false);
	const computedMsgCrc = crc32(frame.subarray(0, total - MESSAGE_CRC_LEN));
	if (computedMsgCrc !== msgCrc) throw new AIError.EventStreamFrameError("message CRC mismatch");

	const headersBytes = frame.subarray(HEADER_BLOCK_OFFSET, HEADER_BLOCK_OFFSET + headersLen);
	const payload = frame.subarray(HEADER_BLOCK_OFFSET + headersLen, total - MESSAGE_CRC_LEN);
	return { headers: parseHeaders(headersBytes), payload };
}

function utf8Decoder(): TextDecoder {
	return new TextDecoder("utf-8", { fatal: true });
}

function decodeUtf8(decoder: TextDecoder, bytes: Uint8Array, label: string): string {
	try {
		return decoder.decode(bytes);
	} catch {
		throw new AIError.EventStreamFrameError(`invalid UTF-8 in ${label}`);
	}
}

function requireBytes(buf: Uint8Array, offset: number, need: number, what: string): void {
	if (need < 0 || offset < 0 || offset + need > buf.length) {
		throw new AIError.EventStreamFrameError(`${what} overruns buffer`);
	}
}

function parseHeaders(buf: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const decoder = utf8Decoder();
	let p = 0;
	while (p < buf.length) {
		requireBytes(buf, p, 1, "header name length");
		const nameLen = view.getUint8(p);
		p += 1;
		requireBytes(buf, p, nameLen, "header name");
		const name = decodeUtf8(decoder, buf.subarray(p, p + nameLen), "header name");
		p += nameLen;

		requireBytes(buf, p, 1, "header value type");
		const type = view.getUint8(p);
		p += 1;
		switch (type) {
			case 0: // bool true
				out[name] = "true";
				break;
			case 1: // bool false
				out[name] = "false";
				break;
			case 2: // byte
				requireBytes(buf, p, 1, "header value");
				out[name] = String(view.getInt8(p));
				p += 1;
				break;
			case 3: // short
				requireBytes(buf, p, 2, "header value");
				out[name] = String(view.getInt16(p, false));
				p += 2;
				break;
			case 4: // integer
				requireBytes(buf, p, 4, "header value");
				out[name] = String(view.getInt32(p, false));
				p += 4;
				break;
			case 5: // long — surface as decimal string to avoid precision loss
				requireBytes(buf, p, 8, "header value");
				out[name] = bigIntFromBytes(buf.subarray(p, p + 8)).toString();
				p += 8;
				break;
			case 6: {
				// byte array — base64 for safe transport
				requireBytes(buf, p, 2, "header value length");
				const len = view.getUint16(p, false);
				p += 2;
				requireBytes(buf, p, len, "header value");
				out[name] = Buffer.from(buf.buffer, buf.byteOffset + p, len).toString("base64");
				p += len;
				break;
			}
			case 7: {
				// string
				requireBytes(buf, p, 2, "header value length");
				const len = view.getUint16(p, false);
				p += 2;
				requireBytes(buf, p, len, "header value");
				out[name] = decodeUtf8(decoder, buf.subarray(p, p + len), "header value");
				p += len;
				break;
			}
			case 8: // timestamp (ms since epoch as i64)
				requireBytes(buf, p, 8, "header value");
				out[name] = new Date(Number(bigIntFromBytes(buf.subarray(p, p + 8)))).toISOString();
				p += 8;
				break;
			case 9: {
				// uuid
				requireBytes(buf, p, 16, "header value");
				const u = buf.subarray(p, p + 16);
				const hex: string[] = [];
				for (let i = 0; i < 16; i++) hex.push(u[i].toString(16).padStart(2, "0"));
				out[name] =
					`${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
				p += 16;
				break;
			}
			default:
				throw new AIError.EventStreamFrameError(`unknown header value type ${type}`);
		}
	}
	return out;
}

function bigIntFromBytes(b: Uint8Array): bigint {
	let v = 0n;
	for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
	// sign-extend (two's complement)
	if (b.length === 8 && b[0] & 0x80) v -= 1n << 64n;
	return v;
}

/**
 * Async generator that consumes a `ReadableStream<Uint8Array>` (e.g. a fetch
 * response body) and yields fully-framed messages. Handles arbitrary chunk
 * boundaries: messages may span multiple chunks, and a single chunk may carry
 * many messages.
 */
export async function* decodeEventStream(
	source: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<EventStreamMessage> {
	const reader = source.getReader();
	const cancelOnAbort = (): void => {
		void reader.cancel(signal?.reason).catch(() => {});
	};
	if (signal?.aborted) cancelOnAbort();
	else signal?.addEventListener("abort", cancelOnAbort, { once: true });
	// Single growable buffer; we slide a read cursor along it and compact when a
	// complete prefix has been consumed. Avoids per-message Uint8Array copies.
	let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	let completed = false;
	try {
		while (true) {
			signal?.throwIfAborted();
			const { value, done } = await reader.read();
			signal?.throwIfAborted();
			if (value && value.length > 0) buf = buf.length === 0 ? value : Buffer.concat([buf, value]);
			let offset = 0;
			while (buf.length - offset >= 4) {
				const dv = new DataView(buf.buffer, buf.byteOffset + offset, buf.length - offset);
				const total = dv.getUint32(0, false);
				// Reject oversized / undersized frames as soon as the length is known,
				// before waiting to buffer the remainder of the body.
				if (total < MIN_MESSAGE_LEN) throw new AIError.EventStreamFrameError(`total length ${total} below minimum`);
				if (total > MAX_FRAME_SIZE) {
					throw new AIError.EventStreamFrameError(`oversized frame (${total} > ${MAX_FRAME_SIZE})`);
				}
				if (buf.length - offset >= PRELUDE_LEN) {
					const headersLen = dv.getUint32(4, false);
					assertFrameLengths(total, headersLen);
				}
				if (buf.length - offset < total) break;
				const frame = buf.subarray(offset, offset + total);
				yield decodeMessage(frame);
				offset += total;
			}
			if (offset > 0) buf = buf.slice(offset);
			if (buf.length > MAX_BUFFER_SIZE) {
				throw new AIError.EventStreamFrameError(`retained buffer exceeds ${MAX_BUFFER_SIZE} bytes`);
			}
			if (done) break;
		}
		if (buf.length > 0) throw new AIError.EventStreamFrameError("truncated message at end of stream");
		completed = true;
	} finally {
		signal?.removeEventListener("abort", cancelOnAbort);
		// On abnormal exit (consumer threw/broke, decode error) cancel the body so the
		// HTTP connection is released instead of draining until GC.
		if (!completed) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

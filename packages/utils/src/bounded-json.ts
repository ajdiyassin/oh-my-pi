export type BoundedJsonReadErrorKind = "missing-body" | "empty-body" | "size" | "invalid-json";

export class BoundedJsonReadError extends Error {
	readonly kind: BoundedJsonReadErrorKind;

	constructor(kind: BoundedJsonReadErrorKind, options: ErrorOptions = {}) {
		super(`Bounded JSON read failed: ${kind}`, options);
		this.name = "BoundedJsonReadError";
		this.kind = kind;
	}
}

/** Read one strict UTF-8 JSON response while bounding retained bytes. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > maxBytes) throw new BoundedJsonReadError("size");
	const reader = response.body?.getReader();
	if (!reader) throw new BoundedJsonReadError("missing-body");

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new BoundedJsonReadError("size");
		}
		chunks.push(value);
	}
	if (totalBytes === 0) throw new BoundedJsonReadError("empty-body");

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	} catch (cause) {
		throw new BoundedJsonReadError("invalid-json", { cause });
	}
}

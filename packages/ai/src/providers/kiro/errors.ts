import { isRecord } from "@oh-my-pi/pi-utils";
import { readBoundedBytes } from "@oh-my-pi/pi-utils/bounded-json";
import * as AIError from "../../error";

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 500;
const MAX_ERROR_CODE_CHARS = 100;
const MAX_REQUEST_ID_CHARS = 200;

function boundedMessage(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_MESSAGE_CHARS);
}
function boundedIdentifier(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value.replace(/[^\w.:/#-]/g, "").slice(0, limit);
}

export class KiroApiError extends AIError.ProviderHttpError {
	override readonly name = "KiroApiError";
	readonly requestId: string | undefined;

	constructor(
		message: string,
		status: number,
		options: AIError.ProviderHttpErrorOptions & { requestId?: string } = {},
	) {
		super(message, status, options);
		this.requestId = options.requestId;
	}
}

export class KiroStreamError extends AIError.ProviderResponseError {
	override readonly name = "KiroStreamError";
	readonly code: string | undefined;
	readonly requestId: string | undefined;

	constructor(
		message: string,
		options: { code?: string; requestId?: string; kind?: AIError.ProviderResponseErrorKind } = {},
	) {
		super(message, { provider: "kiro", kind: options.kind ?? "output" });
		this.code = options.code;
		this.requestId = options.requestId;
	}
}

export async function kiroHttpError(response: Response): Promise<KiroApiError> {
	const requestId = boundedIdentifier(
		response.headers.get("x-amzn-requestid") ?? response.headers.get("x-amz-request-id"),
		MAX_REQUEST_ID_CHARS,
	);
	const body = await readBoundedBytes(response, MAX_ERROR_BODY_BYTES, { truncate: true });
	let parsed: Record<string, unknown> | undefined;
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(body));
		parsed = isRecord(value) ? value : undefined;
	} catch {}
	const codeValue = parsed?.__type ?? parsed?.code ?? parsed?.error;
	const code = boundedIdentifier(
		typeof codeValue === "string" ? codeValue.split("#").at(-1) : undefined,
		MAX_ERROR_CODE_CHARS,
	);
	const detail = boundedMessage(parsed?.message) ?? boundedMessage(parsed?.reason);
	const message = `Kiro HTTP ${response.status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`;
	const error = new KiroApiError(message, response.status, { headers: response.headers, code, requestId });
	return response.status === 413 ? AIError.attach(error, AIError.create(AIError.Flag.ContextOverflow)) : error;
}

export function kiroEventStreamError(headers: Record<string, string>, payload: unknown): KiroStreamError {
	const value = isRecord(payload) ? payload : undefined;
	const codeValue = headers[":exception-type"] ?? headers[":error-code"] ?? value?.code ?? value?.__type;
	const code = boundedIdentifier(codeValue, MAX_ERROR_CODE_CHARS) ?? "KIRO_EVENTSTREAM_ERROR";
	const requestId = boundedIdentifier(value?.requestId, MAX_REQUEST_ID_CHARS);
	const detail = boundedMessage(value?.message);
	return new KiroStreamError(`${code}${detail ? `: ${detail}` : ""}`, { code, requestId });
}

export function isKiroCapacityError(error: unknown): boolean {
	return error instanceof KiroApiError && error.code === "INSUFFICIENT_MODEL_CAPACITY";
}

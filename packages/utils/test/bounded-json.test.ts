import { describe, expect, it } from "bun:test";
import { readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";

describe("readBoundedJson", () => {
	it("reads chunked strict UTF-8 JSON within the byte limit", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Uint8Array.from([0x7b, 0x22, 0x78]));
				controller.enqueue(Uint8Array.from([0x22, 0x3a, 0x31, 0x7d]));
				controller.close();
			},
		});
		expect(await readBoundedJson(new Response(body), 16)).toEqual({ x: 1 });
	});

	it("rejects oversized, empty, and invalid UTF-8 responses with typed failures", async () => {
		await expect(readBoundedJson(new Response("12345"), 4)).rejects.toMatchObject({ kind: "size" });
		await expect(readBoundedJson(new Response(""), 16)).rejects.toMatchObject({ kind: "empty-body" });
		await expect(readBoundedJson(new Response(null), 16)).rejects.toMatchObject({ kind: "missing-body" });
		await expect(
			readBoundedJson(new Response(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), 16),
		).rejects.toMatchObject({ kind: "invalid-json" });
	});
});

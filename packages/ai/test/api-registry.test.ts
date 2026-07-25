import { afterEach, describe, expect, test } from "bun:test";
import {
	type CustomStreamSimpleFn,
	clearCustomApis,
	getCustomApi,
	registerCustomApi,
	unregisterCustomApis,
} from "@oh-my-pi/pi-ai/api-registry";
import {
	getOAuthProvider,
	type OAuthProviderInterface,
	registerOAuthProvider,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai/registry/oauth";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/types";

afterEach(() => {
	clearCustomApis();
});

describe("custom API registry", () => {
	const streamSimple: CustomStreamSimpleFn = () => ({}) as unknown as AssistantMessageEventStream;

	test("rejects registrations that collide with built-in API names", () => {
		expect(() => registerCustomApi("openai-responses", streamSimple)).toThrow(
			'Cannot register custom API "openai-responses": built-in API names are reserved.',
		);
	});

	test("rejects the legacy Kiro extension with an actionable migration", () => {
		for (const api of ["kiro", "kiro-api"]) {
			expect(() => registerCustomApi(api, streamSimple, "omp-provider-kiro")).toThrow(
				"Kiro is built into this OMP version. Remove/disable the omp-provider-kiro extension and restart OMP; your OMP-managed Kiro login can then be configured with /login kiro.",
			);
		}
		expect(() => registerCustomApi("unrelated-custom-api", streamSimple, "another-extension")).not.toThrow();
	});
	test("rejects the legacy Kiro extension at the OAuth registration seam too", () => {
		// Extensions may register their OAuth provider before their custom API, so
		// blocking only `registerCustomApi` would let `kiro` shadow native refresh.
		for (const id of ["kiro", "kiro-api"]) {
			expect(() => registerOAuthProvider({ id, sourceId: "omp-provider-kiro" } as OAuthProviderInterface)).toThrow(
				"Kiro is built into this OMP version. Remove/disable the omp-provider-kiro extension and restart OMP; your OMP-managed Kiro login can then be configured with /login kiro.",
			);
		}
		expect(getOAuthProvider("kiro")).toBeUndefined();
		expect(() =>
			registerOAuthProvider({ id: "unrelated-oauth", sourceId: "another-extension" } as OAuthProviderInterface),
		).not.toThrow();
		unregisterOAuthProviders("another-extension");
	});

	test("unregisterCustomApis removes only matching source registrations", () => {
		registerCustomApi("custom-a", streamSimple, "ext-a");
		registerCustomApi("custom-b", streamSimple, "ext-b");

		unregisterCustomApis("ext-a");

		expect(getCustomApi("custom-a")).toBeUndefined();
		expect(getCustomApi("custom-b")).toBeDefined();
	});

	test("clearCustomApis removes all custom APIs", () => {
		registerCustomApi("custom-a", streamSimple, "ext-a");
		registerCustomApi("custom-b", streamSimple, "ext-b");

		clearCustomApis();

		expect(getCustomApi("custom-a")).toBeUndefined();
		expect(getCustomApi("custom-b")).toBeUndefined();
	});
});

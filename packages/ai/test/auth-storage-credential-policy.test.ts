import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks, ProviderLoginResult } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-credential-policy-test";
const PROVIDER_ID = "test-credential-policy";

function oauthCredential(suffix: string): OAuthCredentials & { type: "oauth" } {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage credential login policy", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;
	let loginResult: ProviderLoginResult;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-policy-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		loginResult = "unused";
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "Credential policy test provider",
			sourceId: SOURCE_ID,
			credentialPolicy: "replace",
			login: async (_callbacks: OAuthLoginCallbacks) => loginResult,
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE_ID);
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("replaces the whole provider pool and persists structured API-key endpoint metadata", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(PROVIDER_ID, [
			{ type: "api_key", key: "old-key" },
			{ type: "api_key", key: "other-old-key" },
		]);
		loginResult = {
			type: "api_key",
			key: "ksk_new-key",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
		};

		const identity = await authStorage.login(PROVIDER_ID, {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(identity).toEqual({ type: "api_key" });
		expect(store.listAuthCredentials(PROVIDER_ID).map(entry => entry.credential)).toEqual([
			{
				type: "api_key",
				key: "ksk_new-key",
				source: "login",
				apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			},
		]);
	});

	it("replaces OAuth credentials while retaining the selected profile identity", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(PROVIDER_ID, [oauthCredential("first"), oauthCredential("second")]);
		loginResult = {
			...oauthCredential("selected"),
			orgId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/selected",
			orgName: "Selected profile",
		};

		const identity = await authStorage.login(PROVIDER_ID, {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(identity).toMatchObject({
			type: "oauth",
			accountId: "account-selected",
			orgId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/selected",
			orgName: "Selected profile",
		});
		const credentials = store.listAuthCredentials(PROVIDER_ID).map(entry => entry.credential);
		expect(credentials).toHaveLength(1);
		expect(credentials[0]).toMatchObject({
			type: "oauth",
			access: "access-selected",
			refresh: "refresh-selected",
			orgId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/selected",
			orgName: "Selected profile",
		});
	});

	it("keeps append as the default when a provider does not opt into replacement", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		unregisterOAuthProviders(SOURCE_ID);
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "Credential policy append provider",
			sourceId: SOURCE_ID,
			login: async () => ({ type: "api_key", key: "new-key" }),
		});
		await authStorage.set(PROVIDER_ID, { type: "api_key", key: "old-key" });

		await authStorage.login(PROVIDER_ID, {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(store.listAuthCredentials(PROVIDER_ID).map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "old-key" },
			{ type: "api_key", key: "new-key", source: "login" },
		]);
	});
});

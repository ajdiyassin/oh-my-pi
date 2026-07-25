import * as AIError from "../error";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const KIRO_SCOPES = ["codewhisperer:completions", "codewhisperer:analysis"] as const;

async function promptRegion(callbacks: OAuthLoginCallbacks): Promise<string> {
	return (await callbacks.onPrompt({ message: "Kiro authentication region", placeholder: "us-east-1" })).trim();
}

export const kiroProvider = {
	id: "kiro",
	name: "Kiro (experimental)",
	envKeys: "KIRO_API_KEY",
	login: async (callbacks: OAuthLoginCallbacks) => {
		const { loginKiroBrowser, loginKiroDevice, validateKiroApiKey } = await import("./oauth/kiro");
		const method = await callbacks.onPrompt({
			message: "Choose Kiro authentication: 1) Browser OAuth 2) AWS Builder ID 3) Google 4) GitHub 5) API key",
			placeholder: "1",
		});
		if (method.trim() === "5") {
			const apiKey = await callbacks.onPrompt({ message: "Paste your Kiro API key", placeholder: "ksk_..." });
			return validateKiroApiKey(apiKey, {
				fetch: callbacks.fetch,
				signal: callbacks.signal,
				apiRegion: Bun.env.KIRO_API_REGION,
			});
		}
		const region = await promptRegion(callbacks);
		if (method.trim() === "1") {
			const clientId = (
				await callbacks.onPrompt({ message: "Kiro browser OAuth client ID", placeholder: "client-id" })
			).trim();
			return loginKiroBrowser(callbacks, {
				region,
				clientId,
				preferredPort: 0,
				scopes: KIRO_SCOPES,
			});
		}
		const kind =
			method.trim() === "2"
				? "builder-id"
				: method.trim() === "3"
					? "google"
					: method.trim() === "4"
						? "github"
						: undefined;
		if (!kind) {
			throw new AIError.OAuthError("Invalid Kiro authentication selection", {
				kind: "validation",
				provider: "kiro",
			});
		}
		const appId =
			kind === "builder-id"
				? undefined
				: await callbacks.onPrompt({ message: "Kiro desktop app ID", placeholder: "app-id" });
		return loginKiroDevice(callbacks, {
			kind,
			region,
			appId: appId?.trim(),
			scopes: KIRO_SCOPES,
		});
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		const { refreshKiroToken } = await import("./oauth/kiro");
		return refreshKiroToken(credentials);
	},
	getApiKey: (credentials: OAuthCredentials) => {
		if (!credentials.orgId) {
			throw new AIError.OAuthError("Kiro OAuth credentials are missing the selected profile", {
				kind: "validation",
				provider: "kiro",
			});
		}
		return JSON.stringify({ token: credentials.access, profileArn: credentials.orgId });
	},
	credentialPolicy: "replace",
} as const satisfies ProviderDefinition;

import * as AIError from "../error";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const KIRO_SCOPES = ["codewhisperer:completions", "codewhisperer:analysis"] as const;

export const kiroProvider = {
	id: "kiro",
	name: "Kiro (experimental)",
	envKeys: "KIRO_API_KEY",
	login: async (callbacks: OAuthLoginCallbacks) => {
		const method = await callbacks.onPrompt({
			message: "Choose Kiro authentication: 1) Browser OAuth 2) Device code 3) API key",
			placeholder: "1",
		});
		const choice = method.trim();
		if (choice === "3") {
			const apiKey = await callbacks.onPrompt({ message: "Paste your Kiro API key", placeholder: "ksk_..." });
			// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
			const { validateKiroApiKey } = await import("./oauth/kiro");
			return validateKiroApiKey(apiKey, {
				fetch: callbacks.fetch,
				signal: callbacks.signal,
				apiRegion: Bun.env.KIRO_API_REGION,
			});
		}
		if (choice === "1") {
			// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
			const { loginKiroBrowser } = await import("./oauth/kiro");
			return loginKiroBrowser(callbacks, {
				issuerUrl: "https://view.awsapps.com/start",
				preferredPort: 0,
				scopes: KIRO_SCOPES,
			});
		}
		if (choice === "2") {
			// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
			const { loginKiroDevice } = await import("./oauth/kiro");
			return loginKiroDevice(callbacks, { scopes: KIRO_SCOPES });
		}
		throw new AIError.OAuthError("Invalid Kiro authentication selection", {
			kind: "validation",
			provider: "kiro",
		});
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
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

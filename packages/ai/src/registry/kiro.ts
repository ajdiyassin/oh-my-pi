import * as AIError from "../error";
import { throwIfKiroLoginCancelled } from "./kiro-cancellation";
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
		throwIfKiroLoginCancelled(callbacks.signal);
		const choice = method.trim();
		if (choice === "3") {
			const apiKey = await callbacks.onPrompt({ message: "Paste your Kiro API key", placeholder: "ksk_..." });
			throwIfKiroLoginCancelled(callbacks.signal);
			// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
			const { validateKiroApiKey } = await import("./oauth/kiro");
			const result = await validateKiroApiKey(apiKey, {
				fetch: callbacks.fetch,
				signal: callbacks.signal,
				apiRegion: Bun.env.KIRO_API_REGION,
			});
			throwIfKiroLoginCancelled(callbacks.signal);
			return result;
		}
		if (choice === "1") {
			// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
			const { loginKiroBrowser } = await import("./oauth/kiro");
			const result = await loginKiroBrowser(callbacks, {
				issuerUrl: "https://view.awsapps.com/start",
				preferredPort: 0,
				scopes: KIRO_SCOPES,
			});
			throwIfKiroLoginCancelled(callbacks.signal);
			return result;
		}
		if (choice === "2") {
			// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
			const { loginKiroDevice } = await import("./oauth/kiro");
			const result = await loginKiroDevice(callbacks, { scopes: KIRO_SCOPES });
			throwIfKiroLoginCancelled(callbacks.signal);
			return result;
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

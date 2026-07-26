import * as AIError from "../error";
import { loginKiroBrowser, loginKiroDevice, refreshKiroToken, validateKiroApiKey } from "./oauth/kiro";
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
		if (method.trim() === "3") {
			const apiKey = await callbacks.onPrompt({ message: "Paste your Kiro API key", placeholder: "ksk_..." });
			return validateKiroApiKey(apiKey, {
				fetch: callbacks.fetch,
				signal: callbacks.signal,
				apiRegion: Bun.env.KIRO_API_REGION,
			});
		}
		if (method.trim() === "1") {
			return loginKiroBrowser(callbacks, {
				issuerUrl: "https://view.awsapps.com/start",
				preferredPort: 0,
				scopes: KIRO_SCOPES,
			});
		}
		if (method.trim() === "2") {
			return loginKiroDevice(callbacks, { scopes: KIRO_SCOPES });
		}
		throw new AIError.OAuthError("Invalid Kiro authentication selection", {
			kind: "validation",
			provider: "kiro",
		});
	},
	refreshToken: refreshKiroToken,
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

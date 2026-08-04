import * as AIError from "../error";
import { throwIfKiroLoginCancelled } from "./kiro-cancellation";
import { loginKiroDevice, refreshKiroToken, validateKiroApiKey } from "./oauth/kiro";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const LOGIN_METHOD_PROMPT = "Select login method\n❯ AWS\n  Builder\n  API";

export const kiroProvider = {
	id: "kiro",
	name: "Kiro",
	envKeys: "KIRO_API_KEY",
	login: async (callbacks: OAuthLoginCallbacks) => {
		const method = await callbacks.onPrompt({
			message: LOGIN_METHOD_PROMPT,
			defaultValue: "AWS",
		});
		throwIfKiroLoginCancelled(callbacks.signal);
		const choice = method.trim().toLowerCase();
		if (choice === "" || choice === "aws" || choice === "1") {
			const result = await loginKiroDevice(callbacks);
			throwIfKiroLoginCancelled(callbacks.signal);
			return result;
		}
		if (choice === "builder" || choice === "2") {
			callbacks.onProgress?.("Builder ID login is not available yet.");
			return "";
		}
		if (choice === "api" || choice === "3") {
			const apiKey = await callbacks.onPrompt({ message: "Paste your Kiro API key", placeholder: "ksk_..." });
			throwIfKiroLoginCancelled(callbacks.signal);
			const result = await validateKiroApiKey(apiKey, {
				fetch: callbacks.fetch,
				signal: callbacks.signal,
				apiRegion: Bun.env.KIRO_API_REGION,
			});
			throwIfKiroLoginCancelled(callbacks.signal);
			return result;
		}
		throw new AIError.OAuthError("Invalid Kiro authentication selection", {
			kind: "validation",
			provider: "kiro",
		});
	},
	refreshToken: (credentials: OAuthCredentials) => refreshKiroToken(credentials),
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

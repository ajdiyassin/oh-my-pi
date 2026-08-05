import * as AIError from "../error";
import { throwIfKiroLoginCancelled } from "./kiro-cancellation";
import { loginKiroDevice, refreshKiroToken, validateKiroApiKey } from "./oauth/kiro";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export async function selectKiroLoginMethod(callbacks: OAuthLoginCallbacks): Promise<"aws" | "builder" | "api"> {
	const answer = callbacks.onSelect
		? await callbacks.onSelect({
				message: "Select Kiro login method",
				options: [
					{ value: "aws", label: "AWS" },
					{ value: "builder", label: "Builder" },
					{ value: "api", label: "API" },
				],
				defaultValue: "aws",
			})
		: await callbacks.onPrompt({
				message: "Select login method\n❯ AWS\n  Builder\n  API",
				defaultValue: "AWS",
			});
	throwIfKiroLoginCancelled(callbacks.signal);

	switch (answer.trim().toLowerCase()) {
		case "":
			throw new AIError.OnPromptRequiredError("Kiro login method");
		case "aws":
		case "1":
			return "aws";
		case "builder":
		case "2":
			return "builder";
		case "api":
		case "3":
			return "api";
		default:
			throw new AIError.OAuthError("Invalid Kiro authentication selection", {
				kind: "validation",
				provider: "kiro",
			});
	}
}

export const kiroProvider = {
	id: "kiro",
	name: "Kiro",
	envKeys: "KIRO_API_KEY",
	login: async (callbacks: OAuthLoginCallbacks) => {
		const method = await selectKiroLoginMethod(callbacks);
		if (method === "aws") {
			const result = await loginKiroDevice(callbacks);
			throwIfKiroLoginCancelled(callbacks.signal);
			return result;
		}
		if (method === "builder") {
			callbacks.onProgress?.("Builder ID login is not available yet.");
			return "";
		}
		const apiKey = await callbacks.onPrompt({ message: "Paste your Kiro API key", placeholder: "ksk_..." });
		throwIfKiroLoginCancelled(callbacks.signal);
		const result = await validateKiroApiKey(apiKey, {
			fetch: callbacks.fetch,
			signal: callbacks.signal,
			apiRegion: Bun.env.KIRO_API_REGION,
		});
		throwIfKiroLoginCancelled(callbacks.signal);
		return result;
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

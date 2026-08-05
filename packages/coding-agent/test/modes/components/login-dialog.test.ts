import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { OAuthSelectPrompt } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LoginDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/login-dialog";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as openModule from "@oh-my-pi/pi-coding-agent/utils/open";
import type { TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("LoginDialogComponent", () => {
	it("links every wrapped authorization URL row to the complete URL", () => {
		settings.override("tui.hyperlinks", "always");
		const openSpy = spyOn(openModule, "openPath").mockImplementation(() => {});
		try {
			const tui = { requestRender() {} } as unknown as TUI;
			const dialog = new LoginDialogComponent(tui, "google-antigravity", () => {});
			const authorizationUrl =
				"https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Foauth-callback&scope=cloud-platform&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

			dialog.showAuth(authorizationUrl);
			const linkTarget = `${authorizationUrl}\x07`;
			const urlRows = dialog
				.render(40)
				.filter(line => line.includes(linkTarget) && !Bun.stripANSI(line).includes("click to open"));

			expect(urlRows.length).toBeGreaterThan(1);
			expect(urlRows.map(line => Bun.stripANSI(line).trim()).join("")).toBe(authorizationUrl);
			expect(urlRows.every(line => line.includes(linkTarget))).toBe(true);
			expect(openSpy).toHaveBeenCalledWith(authorizationUrl);
		} finally {
			openSpy.mockRestore();
		}
	});

	it("isolates native selection input and replaces the previous interactive phase", async () => {
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "kiro", () => {});
		const firstPrompt = dialog.showPrompt("First prompt");
		const selection: OAuthSelectPrompt = {
			message: "Choose a method",
			options: [
				{ value: "aws", label: "AWS" },
				{ value: "builder", label: "Builder" },
			],
			defaultValue: "aws",
		};
		const selectPrompt = dialog.showSelect(selection);

		await expect(firstPrompt).rejects.toBeInstanceOf(Error);
		dialog.pasteText("ignored while selecting");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");

		expect(await selectPrompt).toBe("builder");
		expect(dialog.render(80).join("\n")).toContain("Choose a method");
	});
});

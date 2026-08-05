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

	it("supports the exact Kiro method order through keyboard navigation", async () => {
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "kiro", () => {});
		const selection = dialog.showSelect({
			message: "Select Kiro login method",
			options: [
				{ value: "aws", label: "AWS" },
				{ value: "builder", label: "Builder" },
				{ value: "api", label: "API" },
			],
			defaultValue: "aws",
		});

		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");

		expect(await selection).toBe("api");
	});

	it("replaces URL and region prompt phases and preserves cached defaults in the active input", async () => {
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "kiro", () => {});
		const startUrl = dialog.showPrompt("Enter Start URL", undefined, "https://example.awsapps.com/start");
		const startUrlDone = startUrl.catch(error => error);
		const region = dialog.showPrompt("Enter Region", undefined, "eu-central-1");

		expect(await startUrlDone).toBeInstanceOf(Error);
		const rendered = dialog
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Enter Region");
		expect(rendered).toContain("eu-central-1");
		expect(rendered).not.toContain("Enter Start URL");

		dialog.handleInput("\r");
		expect(await region).toBe("eu-central-1");
	});

	it("shows one user code and the complete verification URL without opening a browser", () => {
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "kiro", () => {});
		const url = "https://device.sso.aws.dev/verify?state=example";

		dialog.showAuth(url, "Confirm this code in the browser", undefined, false, "ABCD-EFGH");
		const rendered = dialog
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(rendered.match(/Code: ABCD-EFGH/g)).toHaveLength(1);
		expect(rendered).toContain(url);
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

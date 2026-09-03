import { beforeAll, describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

interface RenderableBlock {
	render(width: number): string[];
}

function renderPresented(blocks: unknown[]): string {
	return blocks
		.flatMap(block => {
			const maybeRenderable = block as Partial<RenderableBlock>;
			return maybeRenderable.render ? maybeRenderable.render(120) : [String(block)];
		})
		.join("\n");
}

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController Kiro login", () => {
	it("skips refresh and success when login stores no credential (deferred route)", async () => {
		const presentedBlocks: unknown[] = [];
		const authStorage = {
			login: vi.fn(async () => undefined),
		} as unknown as AuthStorage;
		const refreshProvider = vi.fn(async () => {});
		const ctx = {
			oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
			session: { modelRegistry: { authStorage, refreshProvider } },
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		await controller.showOAuthSelector("login", "kiro");
		expect(refreshProvider).not.toHaveBeenCalled();
		expect(renderPresented(presentedBlocks)).not.toContain("Successfully logged in");
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});

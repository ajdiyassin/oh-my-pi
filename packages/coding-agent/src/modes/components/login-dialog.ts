import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthSelectPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import {
	Container,
	getKeybindings,
	Input,
	routeSgrMouseInput,
	SelectList,
	type SgrMouseEvent,
	Spacer,
	Text,
	type TUI,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import { urlHyperlinkAlways, WidthAwareText } from "../../tui";
import { openPath } from "../../utils/open";
import { OverlayPanel } from "./overlay-box";

const LOGIN_SELECT_MAX_VISIBLE = 10;

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends OverlayPanel {
	#contentContainer: Container;
	#input: Input;
	#selectList?: SelectList;
	#phaseContainer?: Container;
	#activeControl: "input" | "select" | undefined;
	#selectListLineOffset = 0;
	#tui: TUI;
	#abortController = new AbortController();
	#inputResolver?: (value: string) => void;
	#inputRejecter?: (error: Error) => void;
	#selectResolver?: (value: string) => void;
	#selectRejecter?: (error: Error) => void;

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
	) {
		const providerInfo = getOAuthProviders().find(p => p.id === providerId);
		const providerName = providerInfo?.name || providerId;
		super(`Login to ${providerName}`);
		this.#tui = tui;

		// Dynamic content area
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		// Input (mounted only while it is the active control)
		this.#input = new Input();
		this.#input.onSubmit = () => {
			if (this.#inputResolver) {
				this.#inputResolver(this.#input.getValue());
				this.#inputResolver = undefined;
				this.#inputRejecter = undefined;
			}
		};
		this.#input.onEscape = () => {
			this.#cancel();
		};
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	#rejectActiveControl(error: Error): void {
		const inputRejecter = this.#inputRejecter;
		this.#inputResolver = undefined;
		this.#inputRejecter = undefined;
		inputRejecter?.(error);

		const selectRejecter = this.#selectRejecter;
		this.#selectResolver = undefined;
		this.#selectRejecter = undefined;
		selectRejecter?.(error);
	}

	#resetContent(): void {
		this.#rejectActiveControl(new Error("Login phase replaced"));
		this.#selectList = undefined;
		this.#phaseContainer = undefined;
		this.#activeControl = undefined;
		this.#selectListLineOffset = 0;
		this.#contentContainer.clear();
	}

	/** Replace the current prompt/select phase without stacking old controls. */
	#resetPhase(): Container {
		this.#rejectActiveControl(new Error("Login phase replaced"));
		this.#selectList = undefined;
		this.#activeControl = undefined;
		this.#selectListLineOffset = 0;
		if (!this.#phaseContainer) {
			this.#phaseContainer = new Container();
			this.#contentContainer.addChild(this.#phaseContainer);
		} else {
			this.#phaseContainer.clear();
		}
		return this.#phaseContainer;
	}

	#cancel(): void {
		if (this.#abortController.signal.aborted) return;
		this.#abortController.abort();
		this.#rejectActiveControl(new Error("Login cancelled"));
		this.onComplete(false, "Login cancelled");
	}

	/** Resolve a selection and leave the selected phase visible until the next phase. */
	#resolveSelect(value: string): void {
		const resolver = this.#selectResolver;
		if (!resolver) return;
		this.#selectResolver = undefined;
		this.#selectRejecter = undefined;
		resolver(value);
	}

	/**
	 * Called by the OAuth `onAuth` callback. Renders the full authorization URL
	 * as the primary copy target — that works from any machine, including
	 * SSH/WSL/headless sessions where the OMP-hosted `launchUrl` would resolve
	 * against the user's local browser and fail. When `launchUrl` is present it
	 * is offered as an additional local shortcut so narrow local terminals still
	 * have a truncation-safe copy target (viewport clipping on a long authorize
	 * URL silently drops trailing OAuth query parameters — e.g.
	 * `code_challenge_method=S256`). Every physical URL row carries its own OSC 8
	 * link to the full URL, so clicking any wrapped fragment opens the same target.
	 */
	showAuth(url: string, instructions?: string, launchUrl?: string, openBrowser = true, userCode?: string): void {
		this.#resetContent();
		this.#contentContainer.addChild(new Spacer(1));
		if (userCode) {
			this.#contentContainer.addChild(new Text(theme.fg("warning", `Code: ${userCode}`), 1, 0));
		}
		this.#contentContainer.addChild(
			new WidthAwareText(
				contentWidth =>
					wrapTextWithAnsi(url, contentWidth)
						.map(row => theme.fg("accent", urlHyperlinkAlways(url, row)))
						.join("\n"),
				0,
				0,
			),
		);

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.#contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 0, 0));

		if (launchUrl && launchUrl !== url) {
			this.#contentContainer.addChild(
				new Text(theme.fg("dim", `Local shortcut (this machine only): ${launchUrl}`), 0, 0),
			);
		}

		if (instructions) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("warning", instructions), 0, 0));
		}

		// Open browser (best-effort) unless the provider explicitly requires a
		// headless/copy-only device flow.
		if (openBrowser) openPath(url);

		this.#tui.requestRender();
	}

	/** Show a native selection phase and wait for its selected value. */
	showSelect(prompt: OAuthSelectPrompt): Promise<string> {
		const phase = this.#resetPhase();
		phase.addChild(new Spacer(1));
		phase.addChild(new Text(theme.fg("text", prompt.message), 1, 0));
		const items = prompt.options.map(option => ({
			value: option.value,
			label: option.label,
			description: option.description,
		}));
		const selectList = new SelectList(
			items,
			Math.max(1, Math.min(LOGIN_SELECT_MAX_VISIBLE, items.length)),
			getSelectListTheme(),
			{ overflowSearch: false },
		);
		const defaultIndex = items.findIndex(item => item.value === prompt.defaultValue);
		if (defaultIndex >= 0) selectList.setSelectedIndex(defaultIndex);
		selectList.onSelect = item => this.#resolveSelect(item.value);
		selectList.onCancel = () => this.#cancel();
		this.#selectList = selectList;
		this.#activeControl = "select";
		this.#selectListLineOffset = 2 + 1 + prompt.message.split("\n").length;
		phase.addChild(selectList);
		phase.addChild(new Text(theme.fg("dim", "(Escape to cancel, Enter to submit)"), 1, 0));

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#selectResolver = resolve;
		this.#selectRejecter = reject;
		this.#tui.requestRender();
		return promise;
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		const phase = this.#resetPhase();
		phase.addChild(new Spacer(1));
		phase.addChild(new Text(theme.fg("dim", prompt), 0, 0));
		phase.addChild(this.#input);
		phase.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 0, 0));
		this.#activeControl = "input";
		this.#input.setValue("");
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input.
	 * The prompt replaces the previous interactive phase instead of stacking.
	 */
	showPrompt(message: string, placeholder?: string, defaultValue?: string): Promise<string> {
		const phase = this.#resetPhase();
		phase.addChild(new Spacer(1));
		phase.addChild(new Text(theme.fg("text", message), 0, 0));
		if (placeholder) {
			phase.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 0, 0));
		}
		phase.addChild(this.#input);
		phase.addChild(new Text(theme.fg("dim", "(Escape to cancel, Enter to submit)"), 0, 0));
		this.#activeControl = "input";
		this.#input.setValue(defaultValue ?? "");
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("dim", message), 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 0, 0));
		this.#tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("dim", message), 0, 0));
		this.#tui.requestRender();
	}

	/** Route a mouse event to the active SelectList only. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#activeControl !== "select" || !this.#selectList) return;
		this.#selectList.routeMouse(event, line - this.#selectListLineOffset, col);
	}

	/** Route non-bracketed paste transports into the active login input only. */
	pasteText(text: string): void {
		if (this.#activeControl === "input") this.#input.pasteText(text);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		// Inline login dialogs do not receive a layout callback with their screen
		// origin. The row-based route remains available to hosts/tests that provide
		// component-local coordinates; wheel events do not need an origin.
		this.routeMouse(event, event.row - 1, event.col);
		return true;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}

		if (this.#activeControl === "select" && this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		if (this.#activeControl === "input") {
			this.#input.handleInput(data);
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) this.#cancel();
	}
}

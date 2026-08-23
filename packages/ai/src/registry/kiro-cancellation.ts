import * as AIError from "../error";

/** Stop a Kiro login immediately after an interactive callback aborts its signal. */
export function throwIfKiroLoginCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AIError.LoginCancelledError();
}

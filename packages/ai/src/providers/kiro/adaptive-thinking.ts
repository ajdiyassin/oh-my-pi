import { Effort, type Model } from "../../types";
import type { KiroModelRequestFields } from "./types";

const EFFORT_ORDER: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

function selectEffort(model: Pick<Model, "thinking">, requested: Effort | undefined): string | undefined {
	const thinking = model.thinking;
	if (!thinking || thinking.efforts.length === 0) return undefined;
	const selected = requested ?? thinking.defaultLevel ?? Effort.Medium;
	const exact = thinking.effortMap?.[selected];
	if (exact) return exact;
	if (thinking.efforts.includes(selected)) return selected;
	const start = Math.max(0, EFFORT_ORDER.indexOf(selected));
	for (let index = start; index < EFFORT_ORDER.length; index++) {
		const candidate = EFFORT_ORDER[index];
		if (thinking.efforts.includes(candidate)) return thinking.effortMap?.[candidate] ?? candidate;
	}
	const highest = thinking.efforts.at(-1);
	return highest ? (thinking.effortMap?.[highest] ?? highest) : undefined;
}

/** Map only schema-derived model metadata; unknown thinking families are omitted. */
export function buildKiroModelRequestFields(
	model: Pick<Model, "thinking" | "maxTokens">,
	requested: Effort | undefined,
	hideThinkingSummary = false,
): KiroModelRequestFields | undefined {
	const effort = selectEffort(model, requested);
	if (!effort || !model.thinking) return undefined;
	if (model.thinking.mode === "anthropic-adaptive") {
		return {
			thinking: { type: "adaptive", display: hideThinkingSummary ? "omitted" : "summarized" },
			output_config: { effort },
			...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
		};
	}
	if (model.thinking.mode === "effort") {
		return { reasoning: { mode: "standard", effort } };
	}
	return undefined;
}

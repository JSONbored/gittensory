/** Typed form state for the config generator (#1683). Field groups append slices here; YAML preview (#2210) serializes later. */

export type AiCombineStrategy = "single" | "consensus" | "synthesis";
export type AiProvider = "anthropic" | "openai";

export type GeneratorGateAiReviewState = {
  combine?: AiCombineStrategy | null;
  provider?: AiProvider | null;
  model?: string | null;
};

export type GeneratorFormState = {
  gate?: {
    aiReview?: GeneratorGateAiReviewState;
  };
};

export function patchGeneratorGateAiReview(
  state: GeneratorFormState,
  patch: Partial<GeneratorGateAiReviewState>,
): GeneratorFormState {
  return {
    ...state,
    gate: {
      ...state.gate,
      aiReview: {
        ...state.gate?.aiReview,
        ...patch,
      },
    },
  };
}

/** Map the AI-provider slice to manifest gate keys (gate.aiReview.* in focus-manifest). */
export function gateAiReviewManifestPatch(aiReview: GeneratorGateAiReviewState | undefined): {
  aiReviewCombine: AiCombineStrategy | null;
  aiReviewProvider: AiProvider | null;
  aiReviewModel: string | null;
} {
  const model = aiReview?.model?.trim();
  return {
    aiReviewCombine: aiReview?.combine ?? null,
    aiReviewProvider: aiReview?.provider ?? null,
    aiReviewModel: model ? model : null,
  };
}

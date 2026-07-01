import {
  AI_REVIEW_CACHE_INPUT_VERSION,
  aiReviewCacheInputFingerprint,
  aiReviewCacheInputMatches,
  cacheMetadataForAiReviewInput,
  type AiReviewCacheInput,
} from "../../src/review/ai-review-cache-input";

const baseInput = (): AiReviewCacheInput => ({
  mode: "block",
  byok: false,
  provider: null,
  model: null,
  reviewerPlan: null,
  profile: null,
  inlineComments: false,
  pathInstructions: [],
  pathGuidance: "",
  repoInstructions: null,
  excludePaths: [],
  changedPaths: ["src/a.ts"],
  features: {
    grounding: false,
    rag: false,
    enrichment: false,
    reputation: false,
  },
});

describe("aiReviewCacheInputFingerprint", () => {
  it("is stable across irrelevant path ordering and whitespace normalization", async () => {
    const left = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      changedPaths: [" src/b.ts ", "src/a.ts", "src/a.ts"],
      excludePaths: ["dist/**", " **/*.lock "],
      repoInstructions: "  Follow the repo guide.  ",
    });
    const right = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      changedPaths: ["src/a.ts", "src/b.ts"],
      excludePaths: ["**/*.lock", "dist/**"],
      repoInstructions: "Follow the repo guide.",
    });

    expect(left).toBe(right);
    expect(left.startsWith(`${AI_REVIEW_CACHE_INPUT_VERSION}:`)).toBe(true);
  });

  it("changes when prompt-affecting review inputs change", async () => {
    const original = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: "consensus", reviewers: [{ model: "a" }, { model: "b" }] },
      pathInstructions: [{ path: "src/**", instructions: "Be strict." }],
      pathGuidance: "Be strict.",
      features: { ...baseInput().features, rag: true },
    });
    const updated = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: "consensus", reviewers: [{ model: "a" }, { model: "c" }] },
      pathInstructions: [{ path: "src/**", instructions: "Be strict." }],
      pathGuidance: "Be strict.",
      features: { ...baseInput().features, rag: true },
    });

    expect(updated).not.toBe(original);
  });

  it("normalizes sparse reviewer plan fields deterministically", async () => {
    const omittedReviewers = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: {},
    });
    const explicitEmpty = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: null, reviewers: [] },
    });
    const sparse = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { reviewers: [{}] },
    });
    const explicit = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: null, reviewers: [{ model: null }] },
    });

    expect(omittedReviewers).toBe(explicitEmpty);
    expect(sparse).toBe(explicit);
  });
});

describe("aiReviewCacheInputMatches", () => {
  it("requires both the current input version and exact fingerprint", async () => {
    const fingerprint = await aiReviewCacheInputFingerprint(baseInput());
    expect(
      aiReviewCacheInputMatches(
        { inputVersion: AI_REVIEW_CACHE_INPUT_VERSION, inputFingerprint: fingerprint },
        fingerprint,
      ),
    ).toBe(true);
    expect(aiReviewCacheInputMatches(undefined, fingerprint)).toBe(false);
    expect(aiReviewCacheInputMatches({ inputFingerprint: fingerprint }, fingerprint)).toBe(false);
    expect(
      aiReviewCacheInputMatches(
        { inputVersion: AI_REVIEW_CACHE_INPUT_VERSION, inputFingerprint: "different" },
        fingerprint,
      ),
    ).toBe(false);
  });

  it("adds cache input metadata without discarding existing review telemetry", async () => {
    const fingerprint = await aiReviewCacheInputFingerprint(baseInput());
    expect(cacheMetadataForAiReviewInput(null, fingerprint)).toEqual({
      inputVersion: AI_REVIEW_CACHE_INPUT_VERSION,
      inputFingerprint: fingerprint,
    });
    expect(cacheMetadataForAiReviewInput({ rag: { injected: true } }, fingerprint)).toEqual({
      rag: { injected: true },
      inputVersion: AI_REVIEW_CACHE_INPUT_VERSION,
      inputFingerprint: fingerprint,
    });
  });
});

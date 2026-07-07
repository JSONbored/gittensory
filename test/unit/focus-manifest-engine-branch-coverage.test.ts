import { describe, expect, it } from "vitest";

import {
  gateConfigToJson,
  MAX_FOCUS_MANIFEST_BYTES,
  parseFocusManifest,
  parseFocusManifestContent,
  reviewConfigToJson,
} from "../../packages/gittensory-engine/src/focus-manifest";

describe("focus-manifest engine branch coverage (#2280)", () => {
  it("warns when settings.linkedIssueHardRules is not an object", () => {
    const parsed = parseFocusManifest({ settings: { linkedIssueHardRules: "not-an-object" } });
    expect(parsed.settings.linkedIssueHardRules).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes('settings.linkedIssueHardRules" must be an object'))).toBe(true);
  });

  it("warns on malformed review.enrichment and unknown analyzer keys", () => {
    const parsed = parseFocusManifest({
      review: {
        enrichment: "not-a-mapping",
      },
    });
    expect(parsed.review.enrichmentAnalyzers).toEqual({});
    expect(parsed.warnings.some((w) => w.includes('review.enrichment" must be a mapping'))).toBe(true);

    const withUnknown = parseFocusManifest({
      review: {
        enrichment: { dependency: true, notARealAnalyzer: false },
      },
    });
    expect(withUnknown.review.enrichmentAnalyzers).toEqual({ dependency: true });
    expect(withUnknown.warnings.some((w) => w.includes('unknown analyzer "notARealAnalyzer"'))).toBe(true);
  });

  it("validates review.labeling_rules entries and reserved gittensor: labels", () => {
    const parsed = parseFocusManifest({
      review: {
        labeling_rules: "not-a-list",
      },
    });
    expect(parsed.review.labelingRules).toEqual([]);
    expect(parsed.warnings.some((w) => w.includes("labeling_rules") && w.includes("list"))).toBe(true);

    const capped = parseFocusManifest({
      review: {
        labeling_rules: Array.from({ length: 51 }, (_, index) => ({
          label: `area:${index}`,
          when_paths: ["src/**"],
        })),
      },
    });
    expect(capped.review.labelingRules).toHaveLength(50);
    expect(capped.warnings.some((w) => w.includes("capped at 50"))).toBe(true);

    const withMissingLabel = parseFocusManifest({
      review: {
        labeling_rules: [{ when_paths: ["src/**"] }],
      },
    });
    expect(withMissingLabel.review.labelingRules).toEqual([]);
    expect(withMissingLabel.warnings.some((w) => w.includes(".label\" is required"))).toBe(true);

    const withRules = parseFocusManifest({
      review: {
        labeling_rules: [
          "not-a-mapping",
          { label: "gittensor:priority", when_paths: ["src/**"] },
          { label: "area:ui", when_paths: ["src/**"] },
          { label: "area:docs", title_contains: "docs" },
          { label: "area:empty" },
        ],
      },
    });
    expect(withRules.review.labelingRules).toEqual([
      { label: "area:ui", whenPaths: ["src/**"], titleContains: null, descriptionContains: null },
      { label: "area:docs", whenPaths: [], titleContains: "docs", descriptionContains: null },
    ]);
    expect(withRules.warnings.some((w) => w.includes("labeling_rules[0]") && w.includes("mapping"))).toBe(true);
    expect(withRules.warnings.some((w) => w.includes('reserved "gittensor:"'))).toBe(true);
    expect(withRules.warnings.some((w) => w.includes("needs at least one of when_paths"))).toBe(true);
  });

  it("serializes labeling_rules optional fields through reviewConfigToJson", () => {
    const manifest = parseFocusManifest({
      review: {
        labeling_rules: [
          {
            label: "area:ui",
            when_paths: ["src/**"],
            title_contains: "feat",
            description_contains: "screenshot",
          },
        ],
      },
    });
    expect(reviewConfigToJson(manifest.review)).toEqual({
      labeling_rules: [
        {
          label: "area:ui",
          when_paths: ["src/**"],
          title_contains: "feat",
          description_contains: "screenshot",
        },
      ],
    });
  });

  it("rejects manifest content whose UTF-8 byte length exceeds MAX_FOCUS_MANIFEST_BYTES", () => {
    const oversized = `wantedPaths:\n  - ${"x".repeat(MAX_FOCUS_MANIFEST_BYTES)}`;
    const parsed = parseFocusManifestContent(oversized);
    expect(parsed.present).toBe(false);
    expect(parsed.warnings.some((w) => w.includes(`${MAX_FOCUS_MANIFEST_BYTES} bytes`))).toBe(true);
  });

  it("serializes gate pack, slop-only mode, and partial cla blocks through gateConfigToJson", () => {
    const gate = parseFocusManifest({
      gate: {
        pack: "oss-anti-slop",
        slop: { mode: "block" },
        cla: { checkRunName: "CLA" },
      },
    }).gate;
    expect(gateConfigToJson(gate)).toMatchObject({
      pack: "oss-anti-slop",
      slop: { mode: "block" },
      cla: { checkRunName: "CLA" },
    });
  });

  it("parses sparse linkedIssueHardRules overlays and settings ai review fields", () => {
    const parsed = parseFocusManifest({
      settings: {
        aiReviewProvider: "openai",
        aiReviewModel: "gpt-4.1",
        manualReviewLabel: "needs-human",
        linkedIssueHardRules: {
          ownerAssignedClose: "block",
          assignedIssueClose: "off",
          missingPointLabelClose: "block",
          maintainerOnlyLabelClose: "off",
          pointBearingLabels: ["gittensor:priority"],
          maintainerOnlyLabels: ["maintainer-only"],
          defaultLabelRepo: true,
          verifyBeforeClose: false,
          closeDelaySeconds: 45,
        },
      },
    });
    expect(parsed.settings.aiReviewProvider).toBe("openai");
    expect(parsed.settings.aiReviewModel).toBe("gpt-4.1");
    expect(parsed.settings.manualReviewLabel).toBe("needs-human");
    expect(parsed.settings.linkedIssueHardRules).toMatchObject({
      ownerAssignedClose: "block",
      pointBearingLabels: ["gittensor:priority"],
      closeDelaySeconds: 45,
    });
  });

  it("accepts valid review enrichment toggles and rejects unsafe visual url templates", () => {
    const enriched = parseFocusManifest({
      review: {
        enrichment: { dependency: true, secret: false },
        visual: {
          preview: { url_template: "http://127.0.0.1/pr-{number}" },
        },
      },
    });
    expect(enriched.review.enrichmentAnalyzers).toEqual({ dependency: true, secret: false });
    expect(enriched.review.visual.preview.urlTemplate).toBeNull();
    expect(enriched.warnings.some((w) => w.includes("url_template"))).toBe(true);
  });

  it("serializes review optional fields through reviewConfigToJson", () => {
    const manifest = parseFocusManifest({
      review: {
        fixHandoff: true,
        auto_merge_summary: false,
        enrichment: { dependency: true },
        labeling_rules: [{ label: "area:ui", title_contains: "ui" }],
        linkedIssueSatisfaction: "advisory",
        visual: { routes: { max_routes: 3 } },
      },
    });
    expect(reviewConfigToJson(manifest.review)).toMatchObject({
      fixHandoff: true,
      auto_merge_summary: false,
      enrichment: { dependency: true },
      labeling_rules: [{ label: "area:ui", title_contains: "ui" }],
      linkedIssueSatisfaction: "advisory",
      visual: { routes: { max_routes: 3 } },
    });
  });

  it("warns when a labeling rule entry omits label entirely", () => {
    const parsed = parseFocusManifest({
      review: {
        labeling_rules: [{ when_paths: ["src/**"] }, { label: null, when_paths: ["docs/**"] }],
      },
    });
    expect(parsed.review.labelingRules).toEqual([]);
    expect(parsed.warnings.filter((w) => w.includes(".label")).length).toBeGreaterThanOrEqual(2);
  });

  it("covers remaining serializer and parser branch edges", () => {
    const slopScoreOnly = parseFocusManifest({ gate: { slop: { minScore: 55 } } });
    expect(gateConfigToJson(slopScoreOnly.gate)).toEqual({ slop: { minScore: 55 } });

    const invalidEnrichmentFlag = parseFocusManifest({
      review: { enrichment: { dependency: "not-a-boolean" } },
    });
    expect(invalidEnrichmentFlag.review.enrichmentAnalyzers).toEqual({});
    expect(invalidEnrichmentFlag.warnings.some((w) => w.includes("review.enrichment.dependency"))).toBe(true);

    const missingLabelKey = parseFocusManifest({
      review: { labeling_rules: [{ when_paths: ["src/**"] }] },
    });
    expect(missingLabelKey.warnings.some((w) => w.includes('.label" is required'))).toBe(true);

    const explicitNullLabel = parseFocusManifest({
      review: { labeling_rules: [{ label: null, when_paths: ["src/**"] }] },
    });
    expect(explicitNullLabel.warnings.some((w) => w.includes('.label" is required'))).toBe(true);

    const notPublicSafeLabel = parseFocusManifest({
      review: { labeling_rules: [{ label: "reward farming", when_paths: ["src/**"] }] },
    });
    expect(notPublicSafeLabel.review.labelingRules).toEqual([]);
    expect(notPublicSafeLabel.warnings.some((w) => w.includes("review.labeling_rules[0].label"))).toBe(true);
    expect(notPublicSafeLabel.warnings.some((w) => w.includes('.label" is required'))).toBe(false);

    const emptyTemplate = parseFocusManifest({
      review: { visual: { preview: { url_template: "" } } },
    });
    expect(emptyTemplate.review.visual.preview.urlTemplate).toBeNull();

    const withInstructions = parseFocusManifest({
      review: { instructions: "Prefer small diffs." },
    });
    expect(reviewConfigToJson(withInstructions.review)).toEqual({ instructions: "Prefer small diffs." });

    const pathsOnlyRule = parseFocusManifest({
      review: { labeling_rules: [{ label: "area:ui", when_paths: ["src/**"] }] },
    });
    expect(reviewConfigToJson(pathsOnlyRule.review)).toEqual({
      labeling_rules: [{ label: "area:ui", when_paths: ["src/**"] }],
    });
  });
});

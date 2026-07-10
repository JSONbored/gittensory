import { describe, expect, it } from "vitest";
import { isScreenshotsEnabled } from "../../src/review/visual-wire";
import { resolveConvergedFeature } from "../../src/review/feature-activation";
import type { FocusManifest } from "../../src/signals/focus-manifest";

describe("isScreenshotsEnabled", () => {
  it("is OFF by default (unset / empty / false)", () => {
    expect(isScreenshotsEnabled({})).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: undefined })).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: "" })).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: "false" })).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: "0" })).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: "off" })).toBe(false);
  });

  it("accepts the codebase truthy vocabulary (1/true/yes/on, case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes", "on", "ON"]) {
      expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: v }), v).toBe(true);
    }
  });
});

// #4616: screenshots is now a `ConvergedFeatureKey` — its per-repo activation decision (global flag AND (a
// `features.screenshots` override OR the GITTENSORY_REVIEW_REPOS allowlist default)) is resolved through the
// SAME shared `resolveConvergedFeature` every other converged feature uses (see feature-activation.test.ts for
// the exhaustive, feature-key-agnostic precedence suite this inherits automatically). The dedicated
// `screenshotsAllowed` helper this file used to test (env flag AND allowlist ONLY, no `features:` override at
// all) was removed as part of that migration; these are its former assertions, ported onto the new call shape
// and extended with the override case `screenshotsAllowed` never had.
describe("screenshots converged-feature activation (env flag AND (features.screenshots override OR the repo cutover allowlist), #4616)", () => {
  const repo = "JSONbored/gittensory";
  const noOverride: Pick<FocusManifest, "features"> = {
    features: { present: false, rag: null, reputation: null, unifiedComment: null, safety: null, grounding: null, e2eTests: null, screenshots: null, improvementSignal: null },
  };

  it("requires BOTH the global flag and the repo allowlist when no override is set", () => {
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_SCREENSHOTS: "true", GITTENSORY_REVIEW_REPOS: repo } as Env, noOverride, "screenshots", repo)).toBe(true);
  });

  it("is false when the global flag is OFF even if the repo is allowlisted (master kill-switch)", () => {
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_SCREENSHOTS: "false", GITTENSORY_REVIEW_REPOS: repo } as Env, noOverride, "screenshots", repo)).toBe(false);
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_REPOS: repo } as Env, noOverride, "screenshots", repo)).toBe(false);
  });

  it("is false when the repo is NOT allowlisted and no override is set, even if the global flag is ON (dormant default)", () => {
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_SCREENSHOTS: "true" } as Env, noOverride, "screenshots", repo)).toBe(false);
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_SCREENSHOTS: "true", GITTENSORY_REVIEW_REPOS: "" } as Env, noOverride, "screenshots", repo)).toBe(false);
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_SCREENSHOTS: "true", GITTENSORY_REVIEW_REPOS: "JSONbored/other" } as Env, noOverride, "screenshots", repo)).toBe(false);
  });

  it("matches the repo case-insensitively within the allowlist", () => {
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_SCREENSHOTS: "on", GITTENSORY_REVIEW_REPOS: "jsonbored/GITTENSORY" } as Env, noOverride, "screenshots", repo)).toBe(true);
  });

  it("(#4616) a `features.screenshots` override now fully controls the feature, even for a repo NOT on the allowlist — the gap this migration fixes", () => {
    const forcedOn: Pick<FocusManifest, "features"> = { features: { ...noOverride.features, present: true, screenshots: true } };
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_SCREENSHOTS: "true" } as Env, forcedOn, "screenshots", "not/allowlisted")).toBe(true);
    const forcedOff: Pick<FocusManifest, "features"> = { features: { ...noOverride.features, present: true, screenshots: false } };
    expect(resolveConvergedFeature({ GITTENSORY_REVIEW_SCREENSHOTS: "true", GITTENSORY_REVIEW_REPOS: repo } as Env, forcedOff, "screenshots", repo)).toBe(false);
  });
});

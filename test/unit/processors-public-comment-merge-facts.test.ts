import { describe, expect, it } from "vitest";

import { derivePublicCommentMergeFacts } from "../../src/queue/processors";
import type { PullRequestFileRecord, RepositorySettings } from "../../src/types";

// `src/rules/**` is one of the ENGINE_DECISION_GUARDRAIL_GLOBS defaults (src/review/guardrail-config.ts), so a
// diff touching it is a hard-guardrail hit; README.md is not guarded by any default glob.
const GUARDED_FILE = { path: "src/rules/advisory.ts" } as PullRequestFileRecord;
const UNGUARDED_FILE = { path: "README.md" } as PullRequestFileRecord;

const NO_GUARDRAIL_OVERRIDES = {
  hardGuardrailGlobs: [],
  hardGuardrailGlobsOverridesInvariants: false,
} as Pick<RepositorySettings, "hardGuardrailGlobs" | "hardGuardrailGlobsOverridesInvariants">;

function facts(overrides: Partial<Parameters<typeof derivePublicCommentMergeFacts>[0]> = {}) {
  return derivePublicCommentMergeFacts({
    liveMergeState: "clean",
    mergeableState: "dirty",
    authorLogin: "contributor",
    liveCi: { ciState: "passed", failingDetails: [], nonRequiredFailingDetails: [] },
    settings: NO_GUARDRAIL_OVERRIDES,
    unifiedFiles: [UNGUARDED_FILE],
    repoFullName: "acme/widgets",
    ...overrides,
  });
}

describe("derivePublicCommentMergeFacts() — mergeStateLabel (#4607)", () => {
  it("prefers the live merge state, falls back to the stored one, and omits the label when neither is known", () => {
    expect(facts({ liveMergeState: "clean", mergeableState: "dirty" }).mergeStateLabel).toBe("clean");
    // The live refresh can fail (it is a `.catch(() => undefined)` at the call site) — fail safe to the stored value.
    expect(facts({ liveMergeState: undefined, mergeableState: "dirty" }).mergeStateLabel).toBe("dirty");
    const unknown = facts({ liveMergeState: undefined, mergeableState: null });
    expect(unknown.mergeStateLabel).toBeUndefined();
    expect(unknown.mergeReadiness).not.toHaveProperty("mergeStateLabel");
  });
});

describe("derivePublicCommentMergeFacts() — ciState (#4607)", () => {
  it("passes through passed/failed and collapses everything else to unverified", () => {
    expect(facts({ liveCi: { ciState: "passed", failingDetails: [], nonRequiredFailingDetails: [] } }).ciState).toBe("passed");
    expect(facts({ liveCi: { ciState: "failed", failingDetails: [], nonRequiredFailingDetails: [] } }).ciState).toBe("failed");
    // Both "pending" and "unverified" mean "we cannot claim green" — the comment must never imply a pass.
    expect(facts({ liveCi: { ciState: "pending", failingDetails: [], nonRequiredFailingDetails: [] } }).ciState).toBe("unverified");
    expect(facts({ liveCi: { ciState: "unverified", failingDetails: [], nonRequiredFailingDetails: [] } }).ciState).toBe("unverified");
  });
});

describe("derivePublicCommentMergeFacts() — failing-check projection (#4607)", () => {
  it("omits the failing keys entirely when nothing is red", () => {
    const { mergeReadiness } = facts();
    expect(mergeReadiness).toEqual({ ciState: "passed", mergeStateLabel: "clean" });
  });

  it("projects name + optional summary/detailsUrl, dropping absent optionals", () => {
    const { mergeReadiness } = facts({
      liveCi: {
        ciState: "failed",
        failingDetails: [
          { name: "codecov/patch", summary: "77% of diff hit", detailsUrl: "https://ci.example/1" },
          { name: "lint" },
        ],
        nonRequiredFailingDetails: [],
      },
    });
    expect(mergeReadiness.failingChecks).toEqual(["codecov/patch", "lint"]);
    expect(mergeReadiness.failingDetails).toEqual([
      { name: "codecov/patch", summary: "77% of diff hit", detailsUrl: "https://ci.example/1" },
      { name: "lint" },
    ]);
    // An absent summary/detailsUrl must be OMITTED, never rendered as an `undefined` chip.
    expect(mergeReadiness.failingDetails?.[1]).not.toHaveProperty("summary");
    expect(mergeReadiness.failingDetails?.[1]).not.toHaveProperty("detailsUrl");
    expect(mergeReadiness).not.toHaveProperty("nonRequiredFailingDetails");
  });

  it("keeps non-required red checks visible WITHOUT folding them into failingChecks (#4414-class)", () => {
    const { mergeReadiness, ciState } = facts({
      liveCi: {
        ciState: "passed",
        failingDetails: [],
        nonRequiredFailingDetails: [{ name: "advisory-scan", summary: "1 note", detailsUrl: "https://ci.example/2" }],
      },
    });
    // The whole point: a non-required red check is surfaced, but it must not turn the PR red or drive close.
    expect(ciState).toBe("passed");
    expect(mergeReadiness).not.toHaveProperty("failingChecks");
    expect(mergeReadiness).not.toHaveProperty("failingDetails");
    expect(mergeReadiness.nonRequiredFailingDetails).toEqual([
      { name: "advisory-scan", summary: "1 note", detailsUrl: "https://ci.example/2" },
    ]);
  });
});

describe("derivePublicCommentMergeFacts() — heldForReview (#guarded-hold-comment, #4607)", () => {
  it("holds a PR whose diff touches a hard-guardrail path, and does not hold one that doesn't", () => {
    expect(facts({ unifiedFiles: [GUARDED_FILE] }).heldForReview).toBe(true);
    expect(facts({ unifiedFiles: [UNGUARDED_FILE] }).heldForReview).toBe(false);
    expect(facts({ unifiedFiles: [UNGUARDED_FILE, GUARDED_FILE] }).heldForReview).toBe(true);
  });

  it("fails SAFE: an empty changed-file list holds for review rather than claiming safe-to-merge", () => {
    // isGuardrailHit (src/signals/change-guardrail.ts) treats "no known changed paths" as a hit — the file list
    // may simply not have resolved, and a false "safe to merge" on an unguarded-looking diff is the dangerous
    // direction. Pinned here because the extraction makes this fail-safe reachable in a unit test for the first
    // time; previously it could only be hit by standing up a whole webhook delivery.
    expect(facts({ unifiedFiles: [] }).heldForReview).toBe(true);
  });

  it("honours a repo that overrides the invariant guardrail globs away", () => {
    expect(
      facts({
        unifiedFiles: [GUARDED_FILE],
        settings: { hardGuardrailGlobs: [], hardGuardrailGlobsOverridesInvariants: true } as Pick<
          RepositorySettings,
          "hardGuardrailGlobs" | "hardGuardrailGlobsOverridesInvariants"
        >,
      }).heldForReview,
    ).toBe(false);
  });
});

describe("derivePublicCommentMergeFacts() — neverClosed (#8/#9, #4607)", () => {
  it("is true for the repo owner, case-insensitively", () => {
    expect(facts({ repoFullName: "acme/widgets", authorLogin: "acme" }).neverClosed).toBe(true);
    expect(facts({ repoFullName: "Acme/widgets", authorLogin: "aCmE" }).neverClosed).toBe(true);
  });

  it("is true for a protected automation author who is NOT the owner", () => {
    expect(facts({ authorLogin: "dependabot[bot]" }).neverClosed).toBe(true);
    expect(facts({ authorLogin: "github-actions[bot]" }).neverClosed).toBe(true);
  });

  it("is false for an ordinary contributor", () => {
    expect(facts({ authorLogin: "contributor" }).neverClosed).toBe(false);
  });

  it("is false — never accidentally true — when the author login is missing", () => {
    // Guard against the empty-string trap: a malformed repoFullName yields an empty owner, and "" === "" would
    // otherwise make an author-less PR look like the repo owner and become un-closable.
    expect(facts({ authorLogin: null, repoFullName: "no-slash-name" }).neverClosed).toBe(false);
    expect(facts({ authorLogin: undefined, repoFullName: "acme/widgets" }).neverClosed).toBe(false);
    expect(facts({ authorLogin: "", repoFullName: "no-slash-name" }).neverClosed).toBe(false);
  });

  it("treats a repoFullName with no owner segment as having no owner", () => {
    expect(facts({ repoFullName: "no-slash-name", authorLogin: "contributor" }).neverClosed).toBe(false);
  });
});

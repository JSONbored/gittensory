import { describe, expect, it } from "vitest";
import { changedPathsHittingGuardrail, isGuardrailHit, matchesAny } from "../../src/signals/change-guardrail";

describe("change-guardrail glob matching", () => {
  it("`**` matches across path separators (a guarded dir guards its whole subtree)", () => {
    expect(matchesAny("scripts/foo/bar.sh", ["scripts/**"])).toBe(true);
    expect(matchesAny("scripts/build.mjs", ["scripts/**"])).toBe(true);
    expect(matchesAny(".github/workflows/ci.yml", [".github/workflows/**"])).toBe(true);
    expect(matchesAny("src/scoring/deep/nested/model.ts", ["src/scoring/**"])).toBe(true);
  });

  it("`**/` also matches zero segments (the dir root itself)", () => {
    expect(matchesAny("packages/index.ts", ["packages/**"])).toBe(true);
  });

  it("`*` matches only within a single segment", () => {
    expect(matchesAny("src/auth.ts", ["src/*.ts"])).toBe(true);
    expect(matchesAny("src/auth/session.ts", ["src/*.ts"])).toBe(false);
  });

  it("matches case-insensitively and canonicalizes `./`, leading `/`, and `\\` separators (evasion-proof)", () => {
    expect(matchesAny(".github/Workflows/ci.yml", [".github/workflows/**"])).toBe(true); // capital W
    expect(matchesAny("Scripts/Deploy.SH", ["scripts/**"])).toBe(true); // mixed case path
    expect(matchesAny("scripts/build.mjs", ["Scripts/**"])).toBe(true); // mixed case glob
    expect(matchesAny("./scripts/build.mjs", ["scripts/**"])).toBe(true); // leading ./
    expect(matchesAny("/scripts/build.mjs", ["scripts/**"])).toBe(true); // leading /
    expect(matchesAny("scripts\\win\\build.ps1", ["scripts/**"])).toBe(true); // backslash separators
    expect(matchesAny("src/a/deep/model.ts", ["src/**/model.ts"])).toBe(true); // mid-path `**/` consumes the separator
    expect(changedPathsHittingGuardrail([".github/Workflows/deploy.yml"], [".github/workflows/**"])).toEqual([".github/Workflows/deploy.yml"]);
  });

  it("does not match unrelated paths", () => {
    expect(matchesAny("docs/readme.md", ["scripts/**", "src/scoring/**"])).toBe(false);
    expect(matchesAny("src/ui/button.tsx", ["src/scoring/**", "src/auth/**"])).toBe(false);
  });

  it("changedPathsHittingGuardrail returns the offending paths (empty globs ⇒ no hits)", () => {
    const globs = ["src/scoring/**", "scripts/**"];
    expect(changedPathsHittingGuardrail(["docs/a.md", "src/scoring/x.ts", "scripts/y.mjs"], globs)).toEqual(["src/scoring/x.ts", "scripts/y.mjs"]);
    expect(changedPathsHittingGuardrail(["docs/a.md", "src/ui/b.tsx"], globs)).toEqual([]);
    expect(changedPathsHittingGuardrail(["src/scoring/x.ts"], [])).toEqual([]);
  });

  it("isGuardrailHit: boolean form shared by the disposition + the comment (#guarded-hold-comment)", () => {
    const globs = ["src/scoring/**", "scripts/**"];
    // No guardrails configured ⇒ never a hit (permissive).
    expect(isGuardrailHit(["src/scoring/x.ts"], [])).toBe(false);
    expect(isGuardrailHit([], [])).toBe(false);
    // A changed path that hits a guarded glob ⇒ hit.
    expect(isGuardrailHit(["docs/a.md", "scripts/y.mjs"], globs)).toBe(true);
    // No changed path hits ⇒ not a hit.
    expect(isGuardrailHit(["docs/a.md", "src/ui/b.tsx"], globs)).toBe(false);
    // FAIL-SAFE (#1062): guardrails configured but the changed-file set is empty (unknown) ⇒ treat as a hit.
    expect(isGuardrailHit([], globs)).toBe(true);
  });

  it("SECURITY (ReDoS): a glob with too many chained wildcards no longer risks catastrophic backtracking — it fails SAFE TOWARD GUARDING (matches every path) instead of ever compiling the pathological pattern", () => {
    // 7 chained single-segment wildcards, empirically catastrophic against a near-miss input (a sibling test in
    // this file's SECURITY section proves >6 stars would otherwise hang for seconds). Must resolve INSTANTLY.
    const pathological = "src/*-*-*-*-*-*-*-final.ts";
    const start = Date.now();
    // A pathological guardrail glob still HOLDS the PR for manual review (the safe direction for a guardrail —
    // silently disabling protection would be far worse than an unnecessary hold).
    expect(matchesAny("completely/unrelated/path.md", [pathological])).toBe(true);
    expect(matchesAny("", [pathological])).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(changedPathsHittingGuardrail(["unrelated/file.ts"], [pathological])).toEqual(["unrelated/file.ts"]);
    expect(isGuardrailHit(["unrelated/file.ts"], [pathological])).toBe(true);
  });

  it("SECURITY (ReDoS): a glob AT the safe cap (6 wildcards) still compiles and matches NORMALLY (not the fail-safe path)", () => {
    // Exactly 6 stars: at the cap, still safely compiled/evaluated — proves the cap is inclusive, not exclusive,
    // and that ordinary (non-pathological) multi-wildcard globs keep their real matching semantics.
    const atCap = "src/*/*/*/*/*/*.ts";
    expect(matchesAny("src/a/b/c/d/e/f.ts", [atCap])).toBe(true);
    expect(matchesAny("src/a/b/c/d/e/f.js", [atCap])).toBe(false); // wrong extension — genuinely doesn't match
  });

  it("a wildcard-free literal glob (e.g. an exact guarded file like '.gittensory.yml') is never treated as unsafe", () => {
    expect(matchesAny(".gittensory.yml", [".gittensory.yml"])).toBe(true);
    expect(matchesAny("other-file.yml", [".gittensory.yml"])).toBe(false);
  });

  it("a mix of one pathological glob among otherwise-fine globs still forces a hold for ANY path (fail-safe dominates)", () => {
    const globs = ["docs/**", "src/*-*-*-*-*-*-*-final.ts"];
    // "docs/**" alone would not match this path, but the pathological glob's fail-safe short-circuits matchesAny
    // to true for every path once any configured glob is judged unsafe to compile.
    expect(matchesAny("completely/unrelated.md", globs)).toBe(true);
  });
});

// #flood-readiness: the live hard-guardrail globs must guard crucial files that live OUTSIDE the dir-prefix
// guards (the awesome-claude #4196 class — a weakened sensitive file slipping through because its folder
// wasn't covered), while leaving clean non-crucial PRs auto-mergeable.
describe("hard-guardrail covers content-crucial files outside the dir-prefix guards", () => {
  const GITTENSORY_GLOBS = [
    ".github/**", "scripts/**", "packages/**", "apps/gittensory-ui/**",
    "src/scoring/**", "src/signals/**", "src/rules/**", "src/gittensor/**", "src/auth/**",
    "src/upstream/**", "src/settings/**", "src/review/**", "src/services/**", "src/github/**", "src/config/**",
  ];

  it("guards crucial files in non-obvious folders (scoring/auth/rules/gate/reviewer)", () => {
    for (const p of [
      "src/services/score-breakdown.ts", // scoring logic under services/
      "src/services/ai-review.ts", // the reviewer engine (#4196 class)
      "src/settings/command-authorization.ts", // authorization under settings/
      "src/settings/agent-actions.ts", // the merge/close decision planner
      "src/upstream/ruleset.ts", // rules under upstream/
      "src/upstream/unmodeled-scoring-drift.ts", // scoring drift under upstream/
      "src/review/guardrail-config.ts", // the guardrail loader itself
      "src/github/backfill.ts", // CI aggregation that gates merges
      "src/config/gittensory-repo-focus-manifest.ts", // scoring focus config
    ]) {
      expect(changedPathsHittingGuardrail([p], GITTENSORY_GLOBS)).toEqual([p]);
    }
  });

  it("still lets clean non-crucial PRs auto-merge (infra/data/registry/docs/tests)", () => {
    const nonCrucial = ["src/utils/json.ts", "src/db/repositories.ts", "src/registry/normalize.ts", "src/mcp/server.ts", "README.md", "docs/x.md", "test/unit/foo.test.ts"];
    expect(changedPathsHittingGuardrail(nonCrucial, GITTENSORY_GLOBS)).toEqual([]);
  });

  it("the hold-all sentinel ['**'] guards every path", () => {
    for (const p of ["src/utils/json.ts", "README.md", "anything/at/all.txt"]) {
      expect(matchesAny(p, ["**"])).toBe(true);
    }
  });
});

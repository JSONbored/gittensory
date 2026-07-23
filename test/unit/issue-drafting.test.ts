import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRAFTING_MISSES_FILE,
  draftIssueBody,
  extractGroundingTerms,
  groundTerm,
  parseDraftingMisses,
  type CorpusFile,
  type DraftingMiss,
  type GroundingTerm,
} from "../../src/services/issue-drafting";

const identifierTerm = (term: string): GroundingTerm => ({ term, tier: "identifier" });

const CORPUS: CorpusFile[] = [
  {
    path: "src/services/threshold-backtest.ts",
    content: "// threshold registry\nexport function detectChangedThresholds(diff: string) {}\nconst KNOWN_THRESHOLDS = {};",
  },
  {
    path: "scripts/backtest-track-record.ts",
    content: 'const THRESHOLD_BACKTEST_EVENT_TYPE = "calibration.threshold_backtest_run";\ncomputeRegressedVerdictTrackRecord(comparisons);',
  },
  {
    path: "packages/loopover-engine/src/calibration/backtest-score.ts",
    content: "export function scoreBacktest() {}",
  },
];

describe("issue-drafting extractGroundingTerms (#8103)", () => {
  it("extracts backticked fragments verbatim as exact-tier, ahead of everything else", () => {
    const terms = extractGroundingTerms("wire `computeRegressedVerdictTrackRecord` into the trend view");
    expect(terms[0]).toEqual({ term: "computeRegressedVerdictTrackRecord", tier: "exact" });
    expect(terms).toContainEqual({ term: "trend", tier: "word" });
    expect(terms).toContainEqual({ term: "view", tier: "word" });
  });

  it("extracts path-shaped tokens (slash paths and bare file.ext) as path-tier without re-extracting their fragments", () => {
    const terms = extractGroundingTerms("mirror scripts/backtest-track-record.ts and wrangler.jsonc here");
    expect(terms).toContainEqual({ term: "scripts/backtest-track-record.ts", tier: "path" });
    expect(terms).toContainEqual({ term: "wrangler.jsonc", tier: "path" });
    // The path token is consumed before later tiers scan: no junk "record.ts" sub-token survives.
    expect(terms.map((extracted) => extracted.term)).not.toContain("record.ts");
  });

  it("extracts camelCase and snake_case/dotted identifiers as identifier-tier", () => {
    const terms = extractGroundingTerms("call scoreBacktest and read metadata_json plus gate.checkMode");
    expect(terms).toContainEqual({ term: "scoreBacktest", tier: "identifier" });
    expect(terms).toContainEqual({ term: "metadata_json", tier: "identifier" });
    expect(terms).toContainEqual({ term: "gate.checkMode", tier: "identifier" });
  });

  it("drops stopwords, short tokens, and case-insensitive duplicates", () => {
    const terms = extractGroundingTerms("add the new backtest for Backtest and a db");
    expect(terms).toEqual([{ term: "backtest", tier: "word" }]);
  });

  it("caps at maxTerms in tier order and clamps a negative cap to zero", () => {
    const prompt = "`exactOne` `exactTwo` scoreBacktest plainword";
    expect(extractGroundingTerms(prompt, 2).map((extracted) => extracted.term)).toEqual(["exactOne", "exactTwo"]);
    expect(extractGroundingTerms(prompt).length).toBe(4);
    expect(extractGroundingTerms(prompt, -1)).toEqual([]);
  });
});

describe("issue-drafting groundTerm (#8103)", () => {
  it("returns null when the corpus has no trace of the term", () => {
    expect(groundTerm(identifierTerm("frobnicator"), CORPUS)).toBeNull();
  });

  it("finds case-insensitive substring matches with 1-based lines and trimmed text", () => {
    const grounded = groundTerm(identifierTerm("KNOWN_thresholds"), CORPUS);
    expect(grounded).toEqual({
      term: "KNOWN_thresholds",
      tier: "identifier",
      matches: [{ path: "src/services/threshold-backtest.ts", line: 3, text: "const KNOWN_THRESHOLDS = {};" }],
    });
  });

  it("ranks src/ ahead of packages/ ahead of scripts/ ahead of test/ ahead of everything else", () => {
    const spread: CorpusFile[] = [
      { path: ".github/workflows/ci.yml", content: "needle" },
      { path: "test/unit/a.test.ts", content: "needle" },
      { path: "scripts/a.ts", content: "needle" },
      { path: "packages/loopover-engine/src/a.ts", content: "needle" },
      { path: "src/a.ts", content: "needle" },
    ];
    const grounded = groundTerm(identifierTerm("needle"), spread, 5);
    expect(grounded!.matches.map((match) => match.path)).toEqual([
      "src/a.ts",
      "packages/loopover-engine/src/a.ts",
      "scripts/a.ts",
      "test/unit/a.test.ts",
      ".github/workflows/ci.yml",
    ]);
  });

  it("breaks rank ties by path then line for deterministic output, and caps matches (min 1)", () => {
    const tied: CorpusFile[] = [
      { path: "src/b.ts", content: "needle\nnot this line\nneedle" },
      { path: "src/a.ts", content: "needle" },
    ];
    const capped = groundTerm(identifierTerm("needle"), tied, 2);
    expect(capped!.matches).toEqual([
      { path: "src/a.ts", line: 1, text: "needle" },
      { path: "src/b.ts", line: 1, text: "needle" },
    ]);
    // A zero/negative cap still keeps one match -- a grounded term with no citation would be useless.
    expect(groundTerm(identifierTerm("needle"), tied, 0)!.matches).toHaveLength(1);
  });

  it("prefers definition lines over comment/usage mentions within the same path rank", () => {
    const withDefinition: CorpusFile[] = [
      { path: "src/a.ts", content: "// scoreBacktest is mentioned here first\nexport function scoreBacktest() {}" },
    ];
    const grounded = groundTerm(identifierTerm("scoreBacktest"), withDefinition);
    expect(grounded!.matches[0]).toEqual({ path: "src/a.ts", line: 2, text: "export function scoreBacktest() {}" });
  });

  it("demotes test files below live code regardless of directory", () => {
    const mixed: CorpusFile[] = [
      { path: "src/services/a.test.ts", content: "needle" },
      { path: "src/services/a.ts", content: "needle" },
    ];
    const grounded = groundTerm(identifierTerm("needle"), mixed, 2);
    expect(grounded!.matches.map((match) => match.path)).toEqual(["src/services/a.ts", "src/services/a.test.ts"]);
  });

  it("grounds word-tier terms only against files whose path contains the word — content-only mentions stay noise", () => {
    const wordCorpus: CorpusFile[] = [
      { path: "src/api/routes.ts", content: "remoteTrackingSha and other track mentions" },
      { path: "scripts/backtest-track-record.ts", content: "the track record tool" },
    ];
    const grounded = groundTerm({ term: "track", tier: "word" }, wordCorpus);
    expect(grounded!.matches).toEqual([{ path: "scripts/backtest-track-record.ts", line: 1, text: "the track record tool" }]);
    // No file path carries the word at all -> not grounded, even though file CONTENT mentions it.
    expect(groundTerm({ term: "verdict", tier: "word" }, wordCorpus)).toBeNull();
  });

  it("bounds captured match text at 160 chars", () => {
    const long = "x".repeat(400);
    const grounded = groundTerm(identifierTerm("xxxx"), [{ path: "src/long.ts", content: long }]);
    expect(grounded!.matches[0]!.text).toHaveLength(160);
  });
});

describe("issue-drafting draftIssueBody (#8103)", () => {
  it("throws on an empty or whitespace-only prompt", () => {
    expect(() => draftIssueBody("", CORPUS)).toThrow(/empty prompt/);
    expect(() => draftIssueBody("   \n", CORPUS)).toThrow(/empty prompt/);
  });

  it("assembles the heavy template with grounded citations, the required-pattern callout, and maintainer markers", () => {
    const result = draftIssueBody("extend `detectChangedThresholds` with a sibling for logic changes", CORPUS);
    expect(result.body).toContain("## Context");
    expect(result.body).toContain("Loose intent (maintainer's own words): extend `detectChangedThresholds`");
    expect(result.body).toContain("Real precedent in the current checkout (verified by search, not memory):");
    expect(result.body).toContain("`src/services/threshold-backtest.ts:2`");
    expect(result.body).toContain("> ⚠️ Required pattern. Mirror the existing implementation in `src/services/threshold-backtest.ts`");
    expect(result.body).toContain("## Deliverables");
    expect(result.body).toContain("<!-- MAINTAINER: name each concrete artifact");
    expect(result.body).toContain("## Expected Outcome");
    expect(result.body).toContain("<!-- MAINTAINER: state what is true after this ships");
    expect(result.body).toContain("## Links & Resources");
    expect(result.body).toContain("- `src/services/threshold-backtest.ts`");
    expect(result.ungroundedTerms).toEqual([]);
  });

  it("flags ungrounded exact/path/identifier terms as ⚠️ UNGROUNDED but silently drops ungrounded plain words", () => {
    const result = draftIssueBody("build a `frobnicator` gizmo around scoreBacktest", CORPUS);
    expect(result.ungroundedTerms).toEqual([{ term: "frobnicator", tier: "exact" }]);
    expect(result.body).toContain('⚠️ UNGROUNDED: no precedent found in the searched checkout for `frobnicator`');
    // "gizmo" is word-tier and absent from the corpus: dropped, not flagged (it still appears in the
    // verbatim Context echo of the prompt, so assert on the UNGROUNDED markers specifically).
    expect(result.body.split("\n").filter((line) => line.includes("UNGROUNDED"))).toHaveLength(1);
    expect(result.groundedTerms.map((grounded) => grounded.term)).toContain("scoreBacktest");
  });

  it("renders the no-precedent-at-all warning when nothing grounds", () => {
    const result = draftIssueBody("build a `frobnicator`", []);
    expect(result.body).toContain("> ⚠️ NO grounded precedent was found for ANY part of this prompt");
    expect(result.body).not.toContain("> ⚠️ Required pattern.");
    expect(result.body).toContain("<!-- MAINTAINER: no grounded files to cite");
    expect(result.groundedTerms).toEqual([]);
  });

  it("dedupes citations landing on the same path:line and groups Requirements one bullet per anchor file", () => {
    const overlapping: CorpusFile[] = [{ path: "src/one.ts", content: "alphaBeta gammaDelta" }];
    const result = draftIssueBody("wire alphaBeta and gammaDelta together", overlapping);
    const citationLines = result.body.split("\n").filter((line) => line.startsWith("- `src/one.ts:1`"));
    expect(citationLines).toHaveLength(1);
    expect(citationLines[0]).toContain('grounds "alphaBeta", "gammaDelta"');
    const anchorBullets = result.body.split("\n").filter((line) => line.startsWith("- Anchor the"));
    expect(anchorBullets).toHaveLength(1);
    expect(anchorBullets[0]).toContain('"alphaBeta" / "gammaDelta"');
  });

  it("keeps separate anchor bullets for terms grounding on different files", () => {
    const result = draftIssueBody("connect detectChangedThresholds to scoreBacktest", CORPUS);
    const anchorBullets = result.body.split("\n").filter((line) => line.startsWith("- Anchor the"));
    expect(anchorBullets).toHaveLength(2);
  });

  it("emits the 99% Codecov requirement when a cited path is coverage-graded", () => {
    const result = draftIssueBody("extend detectChangedThresholds", CORPUS);
    expect(result.body).toContain("99%+ Codecov patch coverage (branch-counted)");
  });

  it("emits the outside-coverage note when only ungraded paths are cited (env.d.ts stays ungraded)", () => {
    const ungraded: CorpusFile[] = [
      { path: "scripts/tool.ts", content: "alphaBeta" },
      { path: "src/env.d.ts", content: "alphaBeta" },
      { path: ".github/workflows/ci.yml", content: "alphaBeta" },
    ];
    const result = draftIssueBody("touch alphaBeta", ungraded);
    expect(result.body).toContain("The cited paths are outside coverage.include");
    expect(result.body).not.toContain("99%+ Codecov patch coverage");
  });

  it("honors maxTerms and maxMatchesPerTerm options", () => {
    const result = draftIssueBody("wire alphaBeta and gammaDelta", [{ path: "src/one.ts", content: "alphaBeta gammaDelta\nalphaBeta again" }], {
      maxTerms: 1,
      maxMatchesPerTerm: 1,
    });
    expect(result.groundedTerms).toHaveLength(1);
    expect(result.groundedTerms[0]!.matches).toHaveLength(1);
  });

  it("is deterministic: same prompt + corpus produce a byte-identical draft", () => {
    const first = draftIssueBody("extend `detectChangedThresholds` and scoreBacktest", CORPUS);
    const second = draftIssueBody("extend `detectChangedThresholds` and scoreBacktest", CORPUS);
    expect(first.body).toBe(second.body);
  });

  it("never emits publish/label/milestone instructions — drafting stays body-text-only (#8103 boundary)", () => {
    const result = draftIssueBody("extend detectChangedThresholds with `frobnicator`", CORPUS);
    for (const forbidden of ["gh issue create", "--label", "milestone:", "auto-publish"]) {
      expect(result.body).not.toContain(forbidden);
    }
  });
});

describe("issue-drafting parseDraftingMisses (#8118)", () => {
  const validMiss = { recordedAt: "2026-07-20T00:00:00.000Z", loosePrompt: "add a thing", missing: "state the exact anti-pattern" };

  it("parses valid records, keeping category only when present and non-empty", () => {
    const parsed = parseDraftingMisses(JSON.stringify([validMiss, { ...validMiss, category: "unstated-anti-pattern" }, { ...validMiss, category: "" }]));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual(validMiss);
    expect(parsed[1]!.category).toBe("unstated-anti-pattern");
    expect(parsed[2]!.category).toBeUndefined();
  });

  it("fails loud on invalid JSON, a non-array root, and malformed entries — a broken lesson file must stop the draft", () => {
    expect(() => parseDraftingMisses("not json")).toThrow(/not valid JSON/);
    expect(() => parseDraftingMisses('{"a":1}')).toThrow(/must be a JSON array/);
    expect(() => parseDraftingMisses(JSON.stringify([null]))).toThrow(/miss #0 is malformed/);
    expect(() => parseDraftingMisses(JSON.stringify([{ ...validMiss, missing: "" }]))).toThrow(/miss #0 is malformed/);
    expect(() => parseDraftingMisses(JSON.stringify([validMiss, { recordedAt: "2026-07-20", loosePrompt: 5, missing: "x" }]))).toThrow(/miss #1 is malformed/);
    expect(() => parseDraftingMisses(JSON.stringify([{ ...validMiss, recordedAt: "" }]))).toThrow(/miss #0 is malformed/);
  });

  it("shares one default misses-file location with the CLIs", () => {
    expect(DEFAULT_DRAFTING_MISSES_FILE).toBe("scripts/drafting-misses.json");
  });
});

describe("issue-drafting draftIssueBody misses checklist (#8118)", () => {
  const miss = (overrides: Partial<DraftingMiss> = {}): DraftingMiss => ({
    recordedAt: "2026-07-20T00:00:00.000Z",
    loosePrompt: "add a thing",
    missing: "verify the exact current function signature against the checkout, not memory",
    ...overrides,
  });

  it("renders no checklist section when no misses are supplied (default and explicit empty)", () => {
    expect(draftIssueBody("extend detectChangedThresholds", CORPUS).body).not.toContain("Pre-publish checklist");
    expect(draftIssueBody("extend detectChangedThresholds", CORPUS, { misses: [] }).body).not.toContain("Pre-publish checklist");
  });

  it("renders every recorded miss as a checklist line the maintainer must resolve and delete", () => {
    const result = draftIssueBody("extend detectChangedThresholds", CORPUS, {
      misses: [miss(), miss({ category: "unstated-anti-pattern", missing: "name what does NOT satisfy the issue" })],
    });
    expect(result.body).toContain("## Pre-publish checklist — learned from recorded drafting misses. Resolve each item, then DELETE this section before publishing.");
    expect(result.body).toContain("- [ ] one-off: verify the exact current function signature against the checkout, not memory");
    expect(result.body).toContain("- [ ] unstated-anti-pattern: name what does NOT satisfy the issue");
  });

  it("collapses same-category repeats into one counted line carrying the most recent lesson", () => {
    const result = draftIssueBody("extend detectChangedThresholds", CORPUS, {
      misses: [
        miss({ category: "unverified-signature", recordedAt: "2026-07-19T00:00:00.000Z", missing: "older lesson wording" }),
        miss({ category: "unverified-signature", recordedAt: "2026-07-21T00:00:00.000Z", missing: "newer lesson wording" }),
        miss({ category: "unverified-signature", recordedAt: "2026-07-20T00:00:00.000Z", missing: "middle lesson wording" }),
      ],
    });
    expect(result.body).toContain("- [ ] unverified-signature (recorded 3×): newer lesson wording");
    expect(result.body).not.toContain("older lesson wording");
  });

  it("keeps uncategorized misses one line per distinct lesson, sorted deterministically", () => {
    const result = draftIssueBody("extend detectChangedThresholds", CORPUS, {
      misses: [miss({ missing: "zeta lesson" }), miss({ missing: "alpha lesson" }), miss({ missing: "alpha lesson" })],
    });
    const checklistLines = result.body.split("\n").filter((line) => line.startsWith("- [ ] one-off"));
    expect(checklistLines).toEqual(["- [ ] one-off (recorded 2×): alpha lesson", "- [ ] one-off: zeta lesson"]);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_POLICY_FATIGUE_CACHE_TTL_MS,
  AI_POLICY_FORMAL_BAN_CACHE_TTL_MS,
  applyAiPolicyFatigueToRankScore,
  aiPolicyVerdictCacheTtlMs,
  detectContributingDocFatigueRevision,
  detectTerseRejectionFatigue,
  inferAiAttributionFromPrMetadata,
  readAiPolicyVerdictCache,
  renderAiPolicyAssessmentMarkdown,
  resolveAiPolicyAssessment,
  resolveAiPolicyVerdict,
  scanAiPolicyText,
  scanContributingDocFatigueLanguage,
  writeAiPolicyVerdictCache,
} from "../dist/index.js";

const NOW_MS = Date.parse("2026-07-04T18:00:00.000Z");
const FATIGUE_NONE = {
  tier: "none" as const,
  priorityAdjustment: "none" as const,
  priorityFactor: 1,
  deferRecheckUntil: null,
  evidence: [],
};

function closedAiPr(number: number, terseRejection = true) {
  return {
    number,
    state: "closed" as const,
    merged: false,
    aiAttributed: true,
    terseRejection,
  };
}

test("barrel: exports AI policy fatigue APIs (#3009)", () => {
  assert.equal(AI_POLICY_FATIGUE_CACHE_TTL_MS < AI_POLICY_FORMAL_BAN_CACHE_TTL_MS, true);
  assert.equal(typeof resolveAiPolicyAssessment, "function");
  assert.equal(typeof detectTerseRejectionFatigue, "function");
  assert.equal(typeof applyAiPolicyFatigueToRankScore, "function");
  assert.equal(typeof writeAiPolicyVerdictCache, "function");
});

test("scanAiPolicyText keeps fatigue distinct from the hard-skip boolean", () => {
  assert.deepEqual(scanAiPolicyText("Please include tests.", "CONTRIBUTING.md"), {
    allowed: true,
    matchedPhrase: null,
    source: "CONTRIBUTING.md",
    fatigue: FATIGUE_NONE,
  });
  assert.deepEqual(scanAiPolicyText("No AI-generated pull requests.", "CONTRIBUTING.md"), {
    allowed: false,
    matchedPhrase: "no ai-generated pull requests",
    source: "CONTRIBUTING.md",
    fatigue: FATIGUE_NONE,
  });
});

test("resolveAiPolicyVerdict remains backward compatible with a default fatigue tier", () => {
  assert.deepEqual(resolveAiPolicyVerdict({ aiUsage: null, contributing: null }), {
    allowed: true,
    matchedPhrase: null,
    source: "none",
    fatigue: FATIGUE_NONE,
  });
});

test("detectTerseRejectionFatigue ignores repos without enough AI-attributed closed PRs", () => {
  assert.deepEqual(detectTerseRejectionFatigue([closedAiPr(1), closedAiPr(2)]), {
    score: 0,
    evidence: [],
  });
});

test("detectTerseRejectionFatigue flags concentrated terse rejections on AI-attributed PRs", () => {
  const result = detectTerseRejectionFatigue([
    closedAiPr(1),
    closedAiPr(2),
    closedAiPr(3),
    closedAiPr(4, false),
  ]);
  assert.ok(result.score >= 0.55);
  assert.equal(result.evidence[0]?.kind, "terse_rejection_pattern");
});

test("inferAiAttributionFromPrMetadata uses bot markers and labels without reading source", () => {
  assert.equal(inferAiAttributionFromPrMetadata({ authorLogin: "dependabot[bot]" }), true);
  assert.equal(inferAiAttributionFromPrMetadata({ labels: ["copilot"] }), true);
  assert.equal(inferAiAttributionFromPrMetadata({ labels: ["bug"] }), false);
});

test("scanContributingDocFatigueLanguage detects AI/automation language short of a ban phrase", () => {
  const evidence = scanContributingDocFatigueLanguage(
    "Please disclose AI-assisted contributions in your PR description.",
    "CONTRIBUTING.md",
  );
  assert.ok(evidence.some((item) => item.kind === "contributing_doc_language"));
});

test("detectContributingDocFatigueRevision weights newly added AI language more heavily", () => {
  const result = detectContributingDocFatigueRevision({
    previous: "Please include tests.",
    current: "Please disclose AI-assisted contributions in your PR description.",
    source: "CONTRIBUTING.md",
    observedAt: "2026-07-04T12:00:00.000Z",
    nowMs: NOW_MS,
  });
  assert.ok(result.score > 0);
  assert.ok(result.evidence.length > 0);
});

test("resolveAiPolicyAssessment combines fatigue-only and formal-ban paths independently", () => {
  const fatigueOnly = resolveAiPolicyAssessment({
    docs: {
      aiUsage: null,
      contributing: "Please disclose AI-assisted contributions in your PR description.",
    },
    closedPullRequests: [closedAiPr(1), closedAiPr(2), closedAiPr(3)],
    nowMs: NOW_MS,
  });
  assert.equal(fatigueOnly.allowed, true);
  assert.notEqual(fatigueOnly.fatigue.tier, "none");

  const formalBan = resolveAiPolicyAssessment({
    docs: {
      aiUsage: null,
      contributing: "No AI-generated pull requests.",
    },
    closedPullRequests: [closedAiPr(1), closedAiPr(2), closedAiPr(3)],
    nowMs: NOW_MS,
  });
  assert.equal(formalBan.allowed, false);
  assert.equal(formalBan.fatigue.tier, "none");
});

test("applyAiPolicyFatigueToRankScore deprioritizes and defers without hard-skipping", () => {
  const deprioritized = applyAiPolicyFatigueToRankScore(
    0.8,
    {
      tier: "elevated",
      priorityAdjustment: "deprioritize",
      priorityFactor: 0.55,
      deferRecheckUntil: null,
      evidence: [],
    },
    NOW_MS,
  );
  assert.equal(deprioritized.rankScore, 0.44);
  assert.equal(deprioritized.deferred, false);

  const deferred = applyAiPolicyFatigueToRankScore(
    0.8,
    {
      tier: "high",
      priorityAdjustment: "defer",
      priorityFactor: 0.15,
      deferRecheckUntil: "2026-07-06T00:00:00.000Z",
      evidence: [],
    },
    NOW_MS,
  );
  assert.equal(deferred.rankScore, 0);
  assert.equal(deferred.deferred, true);
});

test("writeAiPolicyVerdictCache uses a shorter TTL for fatigue than formal bans", () => {
  const cache = new Map();
  const fatigueEntry = writeAiPolicyVerdictCache(
    cache,
    "acme/widgets",
    resolveAiPolicyAssessment({
      docs: {
        aiUsage: null,
        contributing: "Please disclose AI-assisted contributions in your PR description.",
      },
      closedPullRequests: [closedAiPr(1), closedAiPr(2), closedAiPr(3)],
      nowMs: NOW_MS,
    }),
    NOW_MS,
  );
  assert.equal(fatigueEntry.cacheKind, "fatigue");
  assert.equal(fatigueEntry.expiresAtMs - NOW_MS, AI_POLICY_FATIGUE_CACHE_TTL_MS);

  const banEntry = writeAiPolicyVerdictCache(
    cache,
    "acme/banned",
    resolveAiPolicyAssessment({
      docs: { aiUsage: null, contributing: "No AI-generated pull requests." },
      nowMs: NOW_MS,
    }),
    NOW_MS,
  );
  assert.equal(banEntry.cacheKind, "formal_ban");
  assert.equal(aiPolicyVerdictCacheTtlMs(banEntry.verdict), AI_POLICY_FORMAL_BAN_CACHE_TTL_MS);
});

test("readAiPolicyVerdictCache returns null after expiry", () => {
  const cache = new Map();
  writeAiPolicyVerdictCache(
    cache,
    "acme/widgets",
    resolveAiPolicyVerdict({ aiUsage: null, contributing: null }),
    NOW_MS,
  );
  assert.ok(readAiPolicyVerdictCache(cache, "acme/widgets", NOW_MS));
  assert.equal(readAiPolicyVerdictCache(cache, "acme/widgets", NOW_MS + AI_POLICY_FORMAL_BAN_CACHE_TTL_MS + 1), null);
});

test("renderAiPolicyAssessmentMarkdown renders hard-skip and fatigue evidence for observability", () => {
  const verdict = resolveAiPolicyAssessment({
    docs: {
      aiUsage: null,
      contributing: "Please disclose AI-assisted contributions in your PR description.",
    },
    closedPullRequests: [closedAiPr(1), closedAiPr(2), closedAiPr(3)],
    nowMs: NOW_MS,
  });
  const markdown = renderAiPolicyAssessmentMarkdown("acme/widgets", verdict);
  assert.match(markdown, /hard skip: false/u);
  assert.match(markdown, /fatigue tier:/u);
  assert.match(markdown, /Fatigue evidence/u);
});

test("REGRESSION (#3009): formal-ban repos still hard-skip and fatigue never promotes into a ban", () => {
  const verdict = resolveAiPolicyAssessment({
    docs: { aiUsage: null, contributing: "AI-generated PRs are rejected by maintainers." },
    closedPullRequests: [closedAiPr(1), closedAiPr(2), closedAiPr(3), closedAiPr(4)],
    nowMs: NOW_MS,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.matchedPhrase, "ai-generated prs are rejected");
  assert.equal(verdict.fatigue.tier, "none");
});

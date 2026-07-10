// Advisory-only vision verification of a CONTRIBUTOR-pasted screenshot-table (#4366, part of #4325). PURE
// decision + prompt/response logic ONLY, mirroring visual-findings.ts's own separation: this module never
// fetches image bytes, calls an AI provider, or touches D1 -- a caller supplies already-resolved images (as
// `AiContentBlock[]` pairs, see `../../types`) and a resolved BYOK/self-host-vision provider, so this file
// stays testable without network fixtures.
//
// screenshot-table-gate.ts's DETERMINISTIC check only verifies markdown STRUCTURE (a table exists with
// image-bearing cells) -- it has no way to see whether the pasted images are actually two different,
// plausibly-relevant screenshots, or a contributor gaming the gate with a duplicated/unrelated image. This
// module adds that missing check, split into two stages:
//   1. A cheap, deterministic pre-check the LIVE CALLER runs BEFORE reaching this module at all: two fetched
//      images with IDENTICAL base64 bytes need no AI call whatsoever -- see `runScreenshotTableVisionForAdvisory`
//      in processors.ts. Only genuinely different-bytes pairs reach the vision gate below.
//   2. The AI-vision judgment here: for a real (different-bytes) pair, ask a vision-capable model whether the
//      two images still look near-identical (a re-encoded/recompressed duplicate a byte comparison would miss)
//      OR plausibly unrelated to the PR's stated change (a screenshot from an unrelated app/page/topic).
//
// STRICTLY ADVISORY: `SCREENSHOT_TABLE_VISION_FINDING_CODE` is not one of the codes `isConfiguredGateBlocker`
// (src/rules/advisory.ts) recognizes, so this finding can NEVER become a gate blocker -- it rides the
// identical `advisory.findings` pipeline `visual_regression_finding`/`ai_consensus_defect` already use.

import type { AdvisoryFinding } from "../../types";
import { extractLastJsonObject, toPublicSafe, type AiReviewProviderKey } from "../../services/ai-review";
import type { ReputationSignal } from "../submitter-reputation";

/** The advisory finding code a screenshot-table gaming observation is published under (#4366). Deliberately
 *  absent from `isConfiguredGateBlocker`'s allowlist (src/rules/advisory.ts) -- see this file's header. */
export const SCREENSHOT_TABLE_VISION_FINDING_CODE = "screenshot_table_vision_finding";

/** Bound on how many table row image-pairs a single review ever sends to vision -- mirrors
 *  visual-findings.ts's MAX_VISION_ROUTES: a vision call is the most expensive AI request this codebase makes
 *  per-row (an image attachment, not just text), so a table with many rows must never translate into
 *  unbounded spend. */
const MAX_SCREENSHOT_TABLE_VISION_PAIRS = 2;

/** Why {@link evaluateScreenshotTableVisionGate} declined to run the vision call -- observability-only. */
export type ScreenshotTableVisionSkipReason = "no_image_pairs" | "low_reputation" | "byok_not_configured";

export type ScreenshotTableVisionGateResult =
  | { run: false; reason: ScreenshotTableVisionSkipReason }
  | { run: true; pairCount: number };

/**
 * Decide whether a screenshot-table vision call is warranted — mirrors `evaluateVisualVisionGate`'s three-gate
 * shape exactly:
 *   1. at least one real (different-bytes) image pair survived the caller's byte pre-check.
 *   2. submitter reputation — a "low" windowed reputation signal skips vision, same as every other AI neuron.
 *   3. a provider that can actually SEE the images — BYOK or self-host local vision (`env.AI_VISION`, #4335).
 * Pure + total: the caller resolves the reputation signal / provider key / self-host vision availability and
 * the already-byte-deduped pair count; this only decides admission and how many pairs are in play.
 */
export function evaluateScreenshotTableVisionGate(input: {
  imagePairCount: number;
  reputationSignal: ReputationSignal;
  providerKey: AiReviewProviderKey | null;
  selfHostVisionAvailable?: boolean;
}): ScreenshotTableVisionGateResult {
  if (input.reputationSignal === "low") return { run: false, reason: "low_reputation" };
  if (!input.providerKey && !input.selfHostVisionAvailable) return { run: false, reason: "byok_not_configured" };
  const pairCount = Math.min(input.imagePairCount, MAX_SCREENSHOT_TABLE_VISION_PAIRS);
  if (pairCount === 0) return { run: false, reason: "no_image_pairs" };
  return { run: true, pairCount };
}

/** One vision observation the model reported for a specific table row (1-indexed among the pairs sent, not
 *  the row's position in the PR body — the live caller has no cheap way to recover the original row number
 *  once rows have been filtered down to real pairs, and the number only needs to disambiguate WHICH pair a
 *  finding is about when more than one was sent). */
export type ScreenshotTableVisionFinding = { pairIndex: number; body: string };

/** Cap on findings kept from a single vision response — mirrors visual-findings.ts's MAX_VISUAL_FINDINGS. */
const MAX_SCREENSHOT_TABLE_VISION_FINDINGS = 2;

export const SCREENSHOT_TABLE_VISION_SYSTEM_PROMPT = [
  "You are checking a pull request's before/after screenshot-table evidence for gaming, not for visual regressions.",
  "Each pair below is one table row's before image followed by its after image, in that order.",
  'Respond with ONLY a JSON object of this exact shape (no prose, no code fence): {"findings": [{"pairIndex": number, "body": string}]}.',
  "Report a finding for a pair ONLY when the two images are effectively the SAME screenshot (a near-identical",
  "duplicate, not a genuine before/after difference) OR when either image looks implausible as evidence for the",
  "stated change (an unrelated app/website/topic, a blank/broken render, or an obviously irrelevant picture).",
  "Do NOT report a pair just because the visual difference is small — a genuine minor style tweak is exactly",
  "what real before/after evidence looks like. pairIndex is 1 for the first pair, 2 for the second, and so on.",
  "Each body is ONE sentence, specific to what you SEE. Return an empty findings array when every pair looks",
  "like genuine, plausible before/after evidence. Never mention rewards, payouts, wallets, hotkeys, coldkeys, or trust scores.",
].join(" ");

/** Build the user-turn text naming the PR's stated change ahead of the image content blocks — the caller
 *  attaches the actual before/after image pairs (see `../../types`'s `AiContentBlock`); this module only
 *  builds the text half of the request. `prTitle` gives the model the change's stated intent to judge
 *  plausibility against, mirroring how the regular AI review prompt always includes the PR title. */
export function buildScreenshotTableVisionUserPrompt(prTitle: string | null | undefined, pairCount: number): string {
  const titleLine = prTitle && prTitle.trim() ? `Pull request title: ${prTitle.trim()}\n\n` : "";
  return `${titleLine}${pairCount} before/after image pair(s) are attached below, each pair in before, after order.`;
}

/** Parse the model's structured vision response into public-safe findings, dropping anything unparseable, an
 *  out-of-range pairIndex, a blank body, or a body that trips the public/private boundary (`toPublicSafe`).
 *  Bounded to {@link MAX_SCREENSHOT_TABLE_VISION_FINDINGS}. Never throws — an unparseable response degrades to
 *  `[]`, the same fail-safe convention `parseVisualVisionResponse` uses. */
export function parseScreenshotTableVisionResponse(text: string, pairCount: number): ScreenshotTableVisionFinding[] {
  const raw = extractLastJsonObject(text);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const findingsRaw = (parsed as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findingsRaw)) return [];
  const out: ScreenshotTableVisionFinding[] = [];
  for (const entry of findingsRaw) {
    if (out.length >= MAX_SCREENSHOT_TABLE_VISION_FINDINGS) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const pairIndex = typeof record.pairIndex === "number" ? record.pairIndex : NaN;
    const rawBody = typeof record.body === "string" ? record.body : "";
    const body = toPublicSafe(rawBody);
    if (!Number.isInteger(pairIndex) || pairIndex < 1 || pairIndex > pairCount || !body) continue;
    out.push({ pairIndex, body });
  }
  return out;
}

/** Build the ADVISORY-ONLY findings for the unified comment (#4366) — one per vision observation, feeding the
 *  SAME `advisory.findings` pipeline `visual_regression_finding`/`ai_consensus_defect` already ride.
 *  `severity: "warning"` is required, not incidental — `evaluateGateCheckCore` (src/rules/advisory.ts) only
 *  carries `"warning"`-severity findings into `gate.warnings` at all. */
export function buildScreenshotTableVisionFindings(findings: readonly ScreenshotTableVisionFinding[]): AdvisoryFinding[] {
  return findings.map((finding) => ({
    code: SCREENSHOT_TABLE_VISION_FINDING_CODE,
    severity: "warning",
    title: `Possible screenshot-table issue: pair ${finding.pairIndex}`,
    detail: finding.body,
    action: "Advisory only — verify the screenshot-table images against the stated change before deciding.",
  }));
}

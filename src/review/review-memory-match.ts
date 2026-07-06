// Review memory (#2180, matching-logic slice of #1964): a pure, deterministic fingerprint over a finding's
// (category, path, message) plus a matcher that decides suppress/demote/keep against a repo's stored
// review_suppression signals (src/db/repositories.ts's listReviewSuppressions, migrations/0114). NO DB I/O and
// NO AI here — this is the pure decision function findings flow through; the store read (#2178) and the
// apply-to-findings wiring that calls this before rendering the unified comment (#2181) are separate slices.
//
// Suppression is scoped by (category, pathGlob): a stored signal's category must match EXACTLY (categories are
// deterministic finding codes, e.g. "ai_review_split" — never fuzzy), and its pathGlob (canonicalized via
// change-guardrail.ts's globToRegExp, the same bounded/ReDoS-safe glob compiler every other maintainer-
// configured path pattern in this codebase uses) must match the finding's own path ("" = repo-wide, always
// matches). Within that scope: an EXACT message-hash match (the finding recurred VERBATIM) is the strongest
// signal → suppress entirely; a category+path match with a DIFFERENT message hash (the finding shape recurs in
// the same place but worded differently) is a weaker signal → demote (still shown, just downgraded) rather
// than silently dropped, so a genuinely new defect at a previously-dismissed spot is never hidden outright.

import { canonicalize, globToRegExp } from "../signals/change-guardrail";
import type { ReviewSuppressionRecord } from "../types";

/** Bound on the raw message text hashed into a fingerprint — mirrors the codebase's other bounded-input
 *  discipline (e.g. impact-map-wire.ts's MAX_PROMPT_CHARS) so a pathologically long AI-generated finding body
 *  can never make fingerprinting itself expensive. */
const MAX_MESSAGE_LENGTH = 4000;

/** Normalize a finding message for fingerprinting: lowercase, collapse all whitespace runs to a single space,
 *  trim, and bound the length. Two findings that differ only in whitespace/case/wording-drift the AI reviewer
 *  introduces across otherwise-identical re-runs must fingerprint identically, or suppression would never
 *  actually fire on a recurring finding. */
export function normalizeFindingMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH);
}

/** Normalize a finding path for fingerprinting/matching: canonicalize (case/separator-insensitive, mirrors
 *  every other path-pattern consumer in this codebase) and default to "" (repo-wide) when absent. */
export function normalizeFindingPath(path: string | null | undefined): string {
  return path ? canonicalize(path) : "";
}

/** The minimal, decoupled shape review-memory matching needs from a finding — deliberately NOT `AdvisoryFinding`
 *  itself, so this module has zero dependency on the gate's own finding type and stays reusable. `category` is
 *  the finding's own deterministic code (e.g. `ai_review_split`); `path` is optional (absent ⇒ repo-wide). */
export type ReviewMemoryFindingInput = {
  category: string;
  path?: string | null | undefined;
  message: string;
};

/** djb2, a small non-cryptographic string hash — deterministic and collision-resistant enough for this repo-
 *  scoped, non-security-critical fingerprint (an attacker who can already post arbitrary PR content gains
 *  nothing from a hash collision here: worst case is one finding wrongly suppressed/kept, never a gate-verdict
 *  change, since this module is advisory-only by construction). Kept SYNCHRONOUS (no WebCrypto subtle.digest)
 *  so `fingerprint`/`matchSuppressions` stay pure, sync functions the render path can call without threading
 *  `await` through buildDualReviewNotes/buildUnifiedCommentBody. */
function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Deterministic fingerprint over a finding's (category, normalized path, normalized message). PURE — same
 * input always yields the same output, no I/O, no randomness. Two findings with the same category at the same
 * path but differently-worded messages intentionally fingerprint DIFFERENTLY (this hash IS the "pattern_hash"
 * exact-match key — category+path partial matches are handled by `matchSuppressions`, not by fuzzing this hash).
 */
export function fingerprint(finding: ReviewMemoryFindingInput): string {
  const path = normalizeFindingPath(finding.path);
  const message = normalizeFindingMessage(finding.message);
  return djb2Hex(`v1:${finding.category}:${path}:${message}`);
}

export type ReviewMemoryMatchResult = "suppress" | "demote" | "keep";

/** True when `signal.pathGlob` matches `path` — an empty pathGlob ("" = repo-wide) always matches; otherwise
 *  the glob is compiled (bounded/ReDoS-safe, see globToRegExp) and tested against the canonicalized path. */
function pathGlobMatches(pathGlob: string, path: string): boolean {
  if (pathGlob === "") return true;
  return globToRegExp(pathGlob).test(path);
}

/**
 * Decide how a finding should be treated given this repo's stored suppression signals. PURE — no DB I/O (the
 * caller already resolved `signals` via listReviewSuppressions). Bounded — a caller-supplied `signals` array is
 * simply iterated once; the bound on ITS size (MAX_REVIEW_SUPPRESSIONS_PER_REPO) is enforced at the store layer
 * (#2178), not here.
 *
 * - `"suppress"`: some signal's category matches exactly, its pathGlob matches the finding's path, AND its
 *   patternHash equals this finding's own fingerprint — the maintainer dismissed THIS EXACT finding before.
 * - `"demote"`: no exact match, but some signal's category+pathGlob scope matches (a different patternHash) —
 *   the maintainer has dismissed findings from this same category/area before, just not this precise wording.
 * - `"keep"`: no signal's category+pathGlob scope matches this finding at all.
 */
export function matchSuppressions(finding: ReviewMemoryFindingInput, signals: ReadonlyArray<ReviewSuppressionRecord>): ReviewMemoryMatchResult {
  if (signals.length === 0) return "keep";
  const path = normalizeFindingPath(finding.path);
  const findingHash = fingerprint(finding);
  let scopeMatched = false;
  for (const signal of signals) {
    if (signal.category !== finding.category) continue;
    if (!pathGlobMatches(signal.pathGlob, path)) continue;
    if (signal.patternHash === findingHash) return "suppress";
    scopeMatched = true;
  }
  return scopeMatched ? "demote" : "keep";
}

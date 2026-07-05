import { isTestFile } from "../signals/local-branch";
import { isTestPath } from "../signals/test-evidence";

// Deterministic category taxonomy for AI review findings (#1958). The model is asked to self-categorize each
// inlineFinding when review.finding_categories is on; `classifyFindingCategory` supplies the SAFE DEFAULT for
// whatever it omits or mis-emits, so a caller with the feature on always has a category to render — never a
// sometimes-present field. Pure, path/keyword-only — no diff content, no IO.

export const FINDING_CATEGORIES = ["security", "correctness", "performance", "maintainability", "tests", "style"] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** Type guard for a model-provided `category` value — anything outside the fixed enum (wrong case, a made-up
 *  category, a non-string) is rejected so the caller falls back to {@link classifyFindingCategory}. */
export function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && (FINDING_CATEGORIES as readonly string[]).includes(value);
}

const SECURITY_KEYWORDS =
  /\b(?:sql injection|xss|cross-site scripting|csrf|authentication|authorization|secret|credential|vulnerab\w*|sanitiz\w*|command injection|path traversal|ssrf|deserializ\w*|hardcoded (?:password|key|token)|insecure)\b/i;
const PERFORMANCE_KEYWORDS =
  /\b(?:performance|\bslow\b|n\+1|memory leak|inefficient|redundant (?:call|fetch|query)|unnecessary re-?render|blocking call|latency|throughput)\b/i;
const TEST_KEYWORDS = /\b(?:test coverage|missing test|flaky test|test case|assertion)\b/i;
const STYLE_KEYWORDS = /\b(?:naming|formatting|whitespace|indentation|lint\w*|style guide|typo)\b/i;
const MAINTAINABILITY_KEYWORDS =
  /\b(?:duplicat\w*|refactor\w*|readability|overly complex|magic number|dead code|unused (?:variable|import|function))\b/i;

/**
 * Deterministic fallback categorization (#1958): PATH first (a finding anchored to a test file is a "tests"
 * finding regardless of wording), then keyword sniffing over the finding's own body text, ordered so the
 * costliest miscategorization (missing a real security defect) is checked first. Falls through to
 * "correctness" — the general "this is a bug" bucket — when nothing else matches. Pure.
 */
export function classifyFindingCategory(finding: { path: string; body: string }): FindingCategory {
  if (isTestPath(finding.path) || isTestFile(finding.path)) return "tests";
  if (SECURITY_KEYWORDS.test(finding.body)) return "security";
  if (PERFORMANCE_KEYWORDS.test(finding.body)) return "performance";
  if (TEST_KEYWORDS.test(finding.body)) return "tests";
  if (STYLE_KEYWORDS.test(finding.body)) return "style";
  if (MAINTAINABILITY_KEYWORDS.test(finding.body)) return "maintainability";
  return "correctness";
}

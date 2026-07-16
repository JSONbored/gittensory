import { sanitizePublicComment } from "../github/sanitize-public-comment.js";
import { nowIso } from "../utils/json.js";
import { hasValidationNote } from "./test-evidence.js";
import { tokenize } from "./predicted-gate-engine.js";
import { GENERIC_COMMIT_PATTERN, hasClearNoIssueRationale } from "./slop.js";

// Deterministic commit-message + PR-body rubric linter (#549), extracted from
// `packages/loopover-engine/src/signals/engine.ts` (#6268) so the published loopover-mcp CLI can run the
// SAME in-process check the remote server already computes, instead of proxying over HTTP. The full engine
// still carries host-bound imports and is excluded from this package's tsc emit, so `signals/engine.ts`'s
// PR-text-lint exports become a thin re-export shim over this file (imported via relative source path,
// matching this repo's existing engine-consumption convention — see e.g. `./slop.ts`). The shared
// traceability/no-issue-rationale and generic-commit rubric ({@link hasClearNoIssueRationale},
// {@link GENERIC_COMMIT_PATTERN}, {@link tokenize}) is imported from the already-extracted engine modules
// so there is ONE definition, not a hand-kept mirror.

export type PrTextLintInput = {
  commitMessages?: string[] | undefined;
  prBody?: string | undefined;
  linkedIssue?: number | undefined;
};

export type PrTextLintComponent = {
  key: "traceability" | "commit_message" | "pr_body" | "validation_evidence";
  label: string;
  status: "ok" | "weak";
  evidence: string;
  fix?: string | undefined;
};

export type PrTextLintReport = {
  generatedAt: string;
  verdict: "strong" | "adequate" | "weak";
  /**
   * 0-100 PR-text quality score from the deterministic rubric (sum of per-component weights; weak
   * components score 25% of their weight). Advisory sub-signal only — `verdict` is authoritative.
   * Because traceability is a hard gate for the verdict but only one weighted component of the score,
   * the two can rank-disagree (e.g. a strong commit + body with no linked issue scores ~81 yet the
   * verdict is "weak"). Rank by `verdict`, not `score`. Not a Gittensor reward/trust score.
   */
  score: number;
  components: PrTextLintComponent[];
  fixes: string[];
  summary: string;
};

// Conventional Commit subject: one of CONTRIBUTING's allowed types, optional `(scope)`, optional `!`,
// then `: ` and a non-empty summary (e.g. `feat(api): add cursor pagination`). Single source of truth
// with CONTRIBUTING.md "Commit And PR Titles".
const CONVENTIONAL_COMMIT_PATTERN = /^(?:feat|fix|test|docs|refactor|build|ci|chore|revert)(?:\([^()\r\n]+\))?!?:\s+\S/i;
const PR_TEXT_LINT_WEIGHTS = { traceability: 25, commit_message: 30, pr_body: 30, validation_evidence: 15 } as const;

function stripPrBodyScaffolding(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^#{1,6}\s.*$/gm, " ")
    .replace(/^\s*[-*]\s*\[[ xX]\]/gm, " ")
    .replace(/[#>*_`[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic commit-message + PR-body rubric linter. Catches generic/empty AI-slop text before
 * submit and returns a quality verdict plus specific, public-safe fixes. Grades four dimensions:
 * traceability (25 pts), commit message (30 pts), PR body (30 pts), validation evidence (15 pts).
 * Reuses the gittensor traceability/no-issue-rationale rubric ({@link hasClearNoIssueRationale},
 * {@link tokenize}) shared with the public readiness score. All output is routed through
 * {@link sanitizePublicComment}; no private scoring is exposed.
 */
export function buildPrTextLint(input: PrTextLintInput): PrTextLintReport {
  const commitMessages = (input.commitMessages ?? []).map((message) => message.trim()).filter((message) => message.length > 0);
  const prBody = (input.prBody ?? "").trim();
  const linkedIssue = typeof input.linkedIssue === "number" && input.linkedIssue > 0 ? input.linkedIssue : undefined;

  const hasRationale = hasClearNoIssueRationale({ title: "", body: prBody });
  const traceabilityOk = linkedIssue !== undefined || hasRationale;
  const traceability: PrTextLintComponent = traceabilityOk
    ? {
        key: "traceability",
        label: "Traceability",
        status: "ok",
        evidence: linkedIssue !== undefined ? `Linked issue #${linkedIssue}.` : "PR body includes a no-issue rationale.",
      }
    : {
        key: "traceability",
        label: "Traceability",
        status: "weak",
        evidence: "No linked issue and no no-issue rationale in the PR body.",
        fix: 'Link the issue this PR resolves (e.g. "Fixes #123"), or explain in the body why no issue applies.',
      };

  const primaryCommit = commitMessages[0] ?? "";
  const commitTokens = tokenize(commitMessages.join(" "));
  const commitGeneric = primaryCommit.length > 0 && GENERIC_COMMIT_PATTERN.test(primaryCommit);
  // The `^`-anchored pattern matches against the subject line at the start of the message.
  const commitConventional = CONVENTIONAL_COMMIT_PATTERN.test(primaryCommit);
  const commitOk = commitConventional && primaryCommit.length >= 15 && commitTokens.length >= 2 && !commitGeneric;
  const commitMessage: PrTextLintComponent = commitOk
    ? { key: "commit_message", label: "Commit message", status: "ok", evidence: "Commit message is specific and follows Conventional Commit format." }
    : {
        key: "commit_message",
        label: "Commit message",
        status: "weak",
        evidence:
          commitMessages.length === 0
            ? "No commit message was provided."
            : commitGeneric
              ? "Commit message is generic (e.g. update/fix/wip)."
              : !commitConventional
                ? "Commit message does not follow Conventional Commit format (type(scope): summary)."
                : "Commit message is too short or lacks specific detail.",
        fix: "Use a Conventional Commit subject (type(scope): summary, e.g. feat(api): add cursor pagination) that names what changed and why; avoid generic words like update, fix, or wip on their own.",
      };

  const strippedBody = stripPrBodyScaffolding(prBody);
  const bodyTokens = tokenize(strippedBody);
  const bodyLooksTemplated = prBody.length > 0 && /\[[ xX]\]|<!--/.test(prBody);
  // tokenize() only counts ASCII word tokens, so a fully non-Latin (CJK/Cyrillic/…) body yields 0
  // tokens and would be mislabelled "thin". Fall back to a Unicode-aware letter density check so
  // substantive non-Latin prose is recognised before we flag a body as low-effort.
  const bodyNonWhitespace = strippedBody.replace(/\s+/g, "");
  const bodyLetterCount = (bodyNonWhitespace.match(/\p{L}/gu) ?? []).length;
  const bodyLetterDense = bodyNonWhitespace.length >= 24 && bodyLetterCount / bodyNonWhitespace.length >= 0.6;
  const bodyOk = strippedBody.length >= 40 && (bodyTokens.length >= 5 || bodyLetterDense);
  const prBodyComponent: PrTextLintComponent = bodyOk
    ? {
        key: "pr_body",
        label: "PR body",
        status: "ok",
        evidence: hasValidationNote(prBody) ? "PR body describes the change and includes validation notes." : "PR body describes the change with specific detail.",
      }
    : {
        key: "pr_body",
        label: "PR body",
        status: "weak",
        evidence: prBody.length === 0 ? "PR body is empty." : bodyLooksTemplated ? "PR body looks like an unfilled template." : "PR body is thin and lacks specific detail about the change.",
        fix: "Describe what changed, why, and how it was validated; fill in or remove unused template sections.",
      };

  const validationOk = hasValidationNote(prBody);
  const validationEvidence: PrTextLintComponent = validationOk
    ? { key: "validation_evidence", label: "Validation evidence", status: "ok", evidence: "PR body describes how the change was tested or validated." }
    : {
        key: "validation_evidence",
        label: "Validation evidence",
        status: "weak",
        evidence: "PR body does not describe how the change was tested or validated.",
        fix: "Add a short note describing how you validated this change — for example, 'Tested with npm run test:ci' or 'Manually verified the login flow in staging'.",
      };

  const components = [traceability, commitMessage, prBodyComponent, validationEvidence];
  const score = components.reduce((sum, component) => sum + (component.status === "ok" ? PR_TEXT_LINT_WEIGHTS[component.key] : Math.round(PR_TEXT_LINT_WEIGHTS[component.key] * 0.25)), 0);
  const weakCount = components.filter((component) => component.status === "weak").length;
  const verdict: PrTextLintReport["verdict"] = weakCount === 0 ? "strong" : traceabilityOk && weakCount === 1 ? "adequate" : "weak";
  const summary =
    verdict === "strong"
      ? "PR text is traceable, specific, and ready to submit."
      : verdict === "adequate"
        ? "PR text is acceptable but has one area to tighten before submitting."
        : "PR text reads as low-effort; address the flagged items before submitting.";

  return {
    generatedAt: nowIso(),
    verdict,
    score,
    components: components.map((component) => ({
      ...component,
      evidence: sanitizePublicComment(component.evidence),
      ...(component.fix === undefined ? {} : { fix: sanitizePublicComment(component.fix) }),
    })),
    fixes: components.flatMap((component) => (component.fix === undefined ? [] : [sanitizePublicComment(component.fix)])),
    summary: sanitizePublicComment(summary),
  };
}

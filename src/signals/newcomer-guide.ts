/**
 * Advisory newcomer-PR auto-guide (#803, Phase-1-lite). Builds a welcoming, specific advisory comment
 * for first-time-contributor PRs (0 merged PRs in the repo). Advisory only — never blocking, never
 * auto-merge. Reuses the #552 newcomer detection (`authorMergedPrCount === 0`).
 *
 * The guide surfaces the gate findings in a newcomer-friendly way: what to fix, what "merge-worthy"
 * means, and an anti-slop reminder. All text is public-safe (sanitized via `sanitizePublicComment`).
 */

import type { Advisory, AdvisoryFinding } from "../types";

/** Marker for the one-time newcomer guide comment (distinct from the PR panel marker). */
export const NEWCOMER_GUIDE_COMMENT_MARKER = "<!-- gittensory-newcomer-guide:v1 -->";

/** Input for {@link buildNewcomerGuideComment}. */
export type NewcomerGuideInput = {
  /** The PR author's login. */
  authorLogin: string;
  /** The PR number. */
  pullNumber: number;
  /** The PR title. */
  title: string;
  /** Per-repo full name (e.g. "owner/repo"). */
  repoFullName: string;
  /** The advisory findings (used to generate specific guidance). */
  advisory: Advisory;
  /** Whether the gate is blocking (so we can phrase the urgency appropriately). */
  gateBlocking: boolean;
};

/** Finding codes that map to actionable newcomer guidance. */
const FINDING_GUIDANCE: Record<string, { title: string; tip: string }> = {
  missing_linked_issue: {
    title: "Link a related issue",
    tip: 'Mention the issue number in your PR body (e.g. "Closes #123"). Maintainers need to see which issue this addresses.',
  },
  duplicate_pr: {
    title: "Check for duplicate PRs",
    tip: "A similar PR may already be open. Search the PR list and coordinate with other contributors to avoid duplicate work.",
  },
  low_quality_score: {
    title: "Improve code quality",
    tip: "Add tests, handle edge cases, and follow the repo's existing code style. Small, focused PRs are easier to review.",
  },
  slop_detected: {
    title: "Avoid auto-generated or low-effort changes",
    tip: "Make sure every change is intentional and well-understood. Avoid copy-paste from AI tools without understanding the code.",
  },
  ai_slop_advisory: {
    title: "Review AI-generated content carefully",
    tip: "If you used AI assistance, verify every suggestion is correct and necessary. Remove boilerplate or irrelevant changes.",
  },
  merge_readiness: {
    title: "Prepare for merge",
    tip: "Resolve merge conflicts, ensure CI passes, and address reviewer feedback promptly.",
  },
  manifest_blocked_path: {
    title: "Check the contribution guidelines",
    tip: "Some paths in this repo are blocked by policy. Check `.gittensory.yml` or CONTRIBUTING.md for guidance on where to contribute.",
  },
  manifest_linked_issue_required: {
    title: "A linked issue is required",
    tip: 'This repo requires every PR to reference an issue. Add "Closes #NNN" to your PR body.',
  },
  manifest_missing_tests: {
    title: "Add tests",
    tip: "This repo expects tests for new changes. Add or update test files to cover your modifications.",
  },
  ai_consensus_defect: {
    title: "Address potential defects",
    tip: "Two independent AI reviewers flagged a likely defect. Review the findings carefully and fix or explain.",
  },
};

/** Build the newcomer guide comment body. Returns null when no guidance is warranted (no findings). */
export function buildNewcomerGuideComment(input: NewcomerGuideInput): string | null {
  const actionableFindings = filterActionableFindings(input.advisory.findings);
  const lines: string[] = [];

  lines.push(NEWCOMER_GUIDE_COMMENT_MARKER);
  lines.push("");
  lines.push(`## Welcome, @${input.authorLogin}! 👋`);
  lines.push("");
  lines.push(`Thanks for your first PR to **${input.repoFullName}** — "${truncate(input.title, 80)}".`);
  lines.push("");
  lines.push("Here are some tips to help get your PR merged quickly:");

  if (actionableFindings.length > 0) {
    lines.push("");
    for (const finding of actionableFindings) {
      const guidance = FINDING_GUIDANCE[finding.code];
      if (guidance) {
        lines.push(`### ${guidance.title}`);
        lines.push(guidance.tip);
        lines.push("");
      }
    }
  }

  lines.push("### What makes a PR merge-worthy");
  lines.push("- **Small and focused** — one logical change per PR");
  lines.push("- **Linked to an issue** — reference the issue you're solving (e.g. `Closes #123`)");
  lines.push("- **Tested** — add or update tests for your changes");
  lines.push("- **Well-described** — explain what and why in the PR body");
  lines.push("- **CI green** — ensure all checks pass before requesting review");
  lines.push("");

  if (input.gateBlocking) {
    lines.push("> ⚠️ The Gittensory Gate has flagged blockers. Address the items above to unblock your PR.");
    lines.push("");
  } else {
    lines.push("> ✅ No hard blockers detected. A maintainer will review your changes soon.");
    lines.push("");
  }

  lines.push("---");
  lines.push("*This advisory was posted automatically because this is your first PR to this repository. It will not be reposted.*");

  const body = lines.join("\n");
  return body;
}

/** Filter findings to those with actionable newcomer guidance. Deduplicates by code. */
function filterActionableFindings(findings: AdvisoryFinding[]): AdvisoryFinding[] {
  const seen = new Set<string>();
  const result: AdvisoryFinding[] = [];
  for (const finding of findings) {
    if (FINDING_GUIDANCE[finding.code] && !seen.has(finding.code)) {
      seen.add(finding.code);
      result.push(finding);
    }
  }
  return result;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

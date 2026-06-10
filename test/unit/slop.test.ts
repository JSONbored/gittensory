import { describe, expect, it } from "vitest";

import {
  buildSlopAssessment,
  findLowQualityCommitMessages,
  SLOP_RUBRIC_MARKDOWN,
  SLOP_WEIGHTS,
} from "../../src/signals/slop";
import type { IssueRecord, PullRequestRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|trust score|scoreability|private reviewability|\/Users|\/home|\/tmp/i;

function issue(
  repoFullName: string,
  number: number,
  title: string,
  overrides: Partial<IssueRecord> = {},
): IssueRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    labels: ["bug"],
    linkedPrs: [],
    ...overrides,
  };
}

function pr(
  repoFullName: string,
  number: number,
  title: string,
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "contributor",
    authorAssociation: "NONE",
    labels: ["bug"],
    linkedIssues: [],
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSlopAssessment", () => {
  it("raises the slop signal for generic, empty, or template commit messages", () => {
    const repoFullName = "JSONbored/gittensory";
    const result = buildSlopAssessment({
      repoFullName,
      issues: [issue(repoFullName, 7, "Track queue triage")],
      pullRequests: [pr(repoFullName, 41, "Track queue triage")],
      commitMessages: ["fix", "\n\n", "WIP"],
    });

    expect(result.slopRisk).toBe(60);
    expect(result.band).toBe("high");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "low_quality_commit_messages",
          severity: "warning",
        }),
      ]),
    );
  });

  it("does not raise the signal for descriptive commit messages with meaningful terms", () => {
    const repoFullName = "JSONbored/gittensory";
    const result = buildSlopAssessment({
      repoFullName,
      issues: [issue(repoFullName, 8, "Stabilize branch annotations")],
      pullRequests: [pr(repoFullName, 42, "Stabilize branch annotations")],
      commitMessages: [
        "feat(ci): annotate failing checks with branch-specific remediation",
        "docs(api): explain maintainer branch annotation payload",
      ],
    });

    expect(result).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("shares deterministic low-quality classification helpers for the future lint tool", () => {
    const messages = ["update", "feat(api): add branch annotation schema", "the and fix"];

    expect(findLowQualityCommitMessages(messages)).toEqual([
      expect.objectContaining({ subject: "update", reason: "generic_subject" }),
      expect.objectContaining({ subject: "the and fix", reason: "stopword_only_subject" }),
    ]);
    expect(findLowQualityCommitMessages(messages)).toEqual(findLowQualityCommitMessages(messages));
  });

  it("treats punctuation-only, two-bad-message, and long-template subjects consistently", () => {
    const repoFullName = "JSONbored/gittensory";
    expect(findLowQualityCommitMessages(["...", "minor fix"])).toEqual([
      expect.objectContaining({ subject: "...", reason: "empty_subject" }),
      expect.objectContaining({ subject: "minor fix", reason: "generic_subject" }),
    ]);

    const elevated = buildSlopAssessment({
      repoFullName,
      issues: [issue(repoFullName, 11, "Clarify CI notes")],
      pullRequests: [pr(repoFullName, 81, "Clarify CI notes")],
      commitMessages: ["update", "WIP"],
    });
    expect(elevated.slopRisk).toBe(40);
    expect(elevated.band).toBe("elevated");

    const longTemplate = buildSlopAssessment({
      repoFullName,
      issues: [issue(repoFullName, 12, "Trace branch changes")],
      pullRequests: [pr(repoFullName, 82, "Trace branch changes")],
      commitMessages: ["placeholder ".repeat(6).trim(), "temp", "fix"],
    });
    expect(longTemplate.findings[0]?.detail).toContain("...");
  });

  it("keeps the rubric and finding text public-safe", () => {
    const repoFullName = "JSONbored/gittensory";
    const result = buildSlopAssessment({
      repoFullName,
      issues: [issue(repoFullName, 10, "Improve slop scoring")],
      pullRequests: [pr(repoFullName, 71, "Improve slop scoring")],
      commitMessages: ["temp"],
    });
    const publicText = [
      SLOP_RUBRIC_MARKDOWN,
      ...result.findings.flatMap((finding) => [
        finding.title,
        finding.detail,
        finding.action ?? "",
        finding.publicText ?? "",
      ]),
    ].join("\n");

    expect(publicText).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});

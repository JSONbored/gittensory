import { describe, expect, it } from "vitest";
import { evaluateGateCheck, formatGateCheckOutput } from "../../src/rules/advisory";
import {
  evaluateMergeReadinessGateCheck,
  collectMergeReadinessUnmetConditions,
  slopFindingsToAdvisoryFindings,
} from "../../src/rules/merge-readiness-gate";
import { buildPullRequestAdvisory } from "../../src/rules/advisory";
import { buildSlopAssessment } from "../../src/signals/slop";
import type { PullRequestRecord, RepositoryRecord } from "../../src/types";

const repo: RepositoryRecord = {
  fullName: "JSONbored/gittensory",
  owner: "JSONbored",
  name: "gittensory",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "JSONbored/gittensory",
    emissionShare: 0.01,
    issueDiscoveryShare: 0,
    maintainerCut: 0,
    labelMultipliers: {},
    raw: {},
  },
};

describe("merge-readiness aggregate gate", () => {
  it("maps slop findings into advisory findings for composite gates", () => {
    expect(slopFindingsToAdvisoryFindings(buildSlopAssessment({}))).toEqual([]);
    const [finding] = slopFindingsToAdvisoryFindings(
      buildSlopAssessment({ changedFiles: [{ path: "src/app.ts", additions: 4 }] }),
    );
    expect(finding).toMatchObject({ code: "missing_test_evidence", title: "Code changes lack test evidence" });
  });

  it("keeps legacy per-gate behavior when composite mode is off", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 11,
      title: "Add panel",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [],
    };
    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });

    expect(evaluateGateCheck(advisory, { mergeReadinessGateMode: "off", linkedIssueGateMode: "block" }).conclusion).toBe("failure");
    expect(evaluateGateCheck(advisory, { mergeReadinessGateMode: "off", linkedIssueGateMode: "advisory" }).conclusion).toBe("success");
  });

  it("blocks merge when composite mode is block and any enabled sub-gate is unmet", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 12,
      title: "Add panel",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [],
    };
    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });
    const slopFindings = slopFindingsToAdvisoryFindings(
      buildSlopAssessment({ changedFiles: [{ path: "src/app.ts", additions: 12 }] }),
    );

    const gate = evaluateGateCheck(advisory, {
      mergeReadinessGateMode: "block",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "off",
      qualityGateMode: "block",
      qualityGateMinScore: 90,
      readinessScore: 40,
      slopFindings,
    });
    const output = formatGateCheckOutput(gate);

    expect(gate.conclusion).toBe("failure");
    expect(gate.blockers.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["missing_linked_issue", "readiness_score_below_threshold", "missing_test_evidence"]),
    );
    expect(gate.summary).toContain("still blocking");
    expect(output.text).toContain("No linked issue detected");
    expect(output.text).toContain("Readiness score is below the configured threshold");
    expect(output.text).toContain("Code changes lack test evidence");
  });

  it("passes with advisory composite mode while keeping unmet conditions visible as warnings", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 13,
      title: "Add panel",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [],
    };
    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });

    const gate = evaluateMergeReadinessGateCheck(advisory, {
      mergeReadinessGateMode: "advisory",
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "off",
      qualityGateMode: "off",
    });

    expect(gate.conclusion).toBe("success");
    expect(gate.blockers).toEqual([]);
    expect(gate.warnings.map((finding) => finding.code)).toContain("missing_linked_issue");
    expect(gate.summary).toContain("remain advisory");
  });

  it("passes composite gate when all enabled sub-gates are satisfied", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 14,
      title: "Add panel",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [42],
    };
    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });

    const gate = evaluateMergeReadinessGateCheck(advisory, {
      mergeReadinessGateMode: "block",
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "off",
      qualityGateMode: "block",
      qualityGateMinScore: 80,
      readinessScore: 90,
    });

    expect(gate.conclusion).toBe("success");
    expect(gate.summary).toContain("passed");
  });

  it("routes broken evaluation state to action_required in composite mode", () => {
    const gate = evaluateMergeReadinessGateCheck(buildPullRequestAdvisory(null, null), {
      mergeReadinessGateMode: "block",
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "off",
      qualityGateMode: "off",
    });

    expect(gate.conclusion).toBe("action_required");
    expect(gate.blockers.map((finding) => finding.code)).toEqual(expect.arrayContaining(["repo_not_registered", "pr_not_cached"]));
  });

  it("honors sub-gate off modes and empty slop findings when collecting unmet conditions", () => {
    const pr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 15,
      title: "Add panel",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [],
    };
    const advisory = buildPullRequestAdvisory(repo, pr, { requireLinkedIssue: true });
    const slopFindings = slopFindingsToAdvisoryFindings(
      buildSlopAssessment({ changedFiles: [{ path: "src/app.ts", additions: 12 }] }),
    );

    expect(
      collectMergeReadinessUnmetConditions(advisory, {
        mergeReadinessGateMode: "block",
        linkedIssueGateMode: "off",
        duplicatePrGateMode: "off",
        qualityGateMode: "off",
        slopFindings: [],
      }),
    ).toEqual([]);

    expect(
      collectMergeReadinessUnmetConditions(advisory, {
        mergeReadinessGateMode: "block",
        linkedIssueGateMode: "block",
        duplicatePrGateMode: "off",
        qualityGateMode: "off",
        slopFindings,
      }).map((finding) => finding.code),
    ).toEqual(expect.arrayContaining(["missing_linked_issue", "missing_test_evidence"]));
  });

  it("includes duplicate and quality sub-gates in composite unmet conditions", () => {
    const linkedPr: PullRequestRecord = {
      repoFullName: repo.fullName,
      number: 16,
      title: "Duplicate work",
      state: "open",
      authorLogin: "contributor",
      authorAssociation: "NONE",
      headSha: "abc123",
      labels: [],
      linkedIssues: [99],
    };
    const duplicateAdvisory = buildPullRequestAdvisory(repo, linkedPr, {
      otherOpenPullRequests: [{ ...linkedPr, number: 17, linkedIssues: [99] }],
    });
    const readyPr: PullRequestRecord = {
      ...linkedPr,
      number: 18,
      linkedIssues: [100],
    };
    const qualityAdvisory = buildPullRequestAdvisory(repo, readyPr, { requireLinkedIssue: true });

    expect(
      collectMergeReadinessUnmetConditions(duplicateAdvisory, {
        mergeReadinessGateMode: "block",
        linkedIssueGateMode: "off",
        duplicatePrGateMode: "block",
        qualityGateMode: "off",
      }).map((finding) => finding.code),
    ).toEqual(["duplicate_pr_risk"]);

    const qualityGate = evaluateMergeReadinessGateCheck(qualityAdvisory, {
      mergeReadinessGateMode: "block",
      linkedIssueGateMode: "off",
      duplicatePrGateMode: "off",
      qualityGateMode: "block",
      qualityGateMinScore: 90,
      readinessScore: 55,
    });

    expect(qualityGate.conclusion).toBe("failure");
    expect(qualityGate.summary).toBe("1 merge-readiness condition still blocking: Readiness score is below the configured threshold.");
  });
});

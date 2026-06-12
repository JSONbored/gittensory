import { describe, expect, it } from "vitest";
import { evaluateGateCheck } from "../../src/rules/advisory";
import {
  applyFirstTimeContributorGrace,
  isRepeatClosedUnmergedAuthor,
  resolveContributorGraceGatePolicy,
  shouldGrantFirstTimeContributorGrace,
} from "../../src/rules/gate-grace";
import type { ContributorOutcomeHistory, RoleContext } from "../../src/signals/engine";

const maintainerRoleContext: RoleContext = {
  login: "maintainer",
  repoFullName: "JSONbored/gittensory",
  generatedAt: "2026-06-12T00:00:00.000Z",
  role: "collaborator",
  maintainerLane: true,
  normalContributorEvidenceAllowed: false,
  source: "github_association",
  association: "MEMBER",
  reasons: [],
  guidance: "Maintainer lane",
};

const newcomerOutcome: ContributorOutcomeHistory["repoOutcomes"][number] = {
  repoFullName: "JSONbored/gittensory",
  role: "outside_contributor",
  lane: "direct_pr",
  maintainerLane: false,
  pullRequests: 1,
  mergedPullRequests: 0,
  openPullRequests: 1,
  closedPullRequests: 0,
  closedPullRequestRate: 0,
  issues: 0,
  openIssues: 0,
  closedIssues: 0,
  solvedIssues: 0,
  validSolvedIssues: 0,
  credibility: 1,
  issueCredibility: 1,
  isEligible: true,
  successLevel: "weak",
  strengths: [],
  risks: [],
};

const repeatOffenderOutcome: ContributorOutcomeHistory["repoOutcomes"][number] = {
  ...newcomerOutcome,
  pullRequests: 3,
  openPullRequests: 1,
  closedPullRequests: 2,
  closedPullRequestRate: 2 / 3,
};

describe("first-time contributor gate grace", () => {
  it("detects repeat closed-unmerged authors", () => {
    expect(isRepeatClosedUnmergedAuthor(repeatOffenderOutcome)).toBe(true);
    expect(isRepeatClosedUnmergedAuthor(newcomerOutcome)).toBe(false);
    expect(isRepeatClosedUnmergedAuthor(undefined)).toBe(false);
  });

  it("grants grace for first-time contributors but not repeat offenders or maintainers", () => {
    const contributorRole = { ...maintainerRoleContext, maintainerLane: false, role: "outside_contributor" as const };

    expect(shouldGrantFirstTimeContributorGrace({ enabled: false, roleContext: contributorRole, repoOutcome: newcomerOutcome })).toBe(false);
    expect(shouldGrantFirstTimeContributorGrace({ enabled: true, roleContext: contributorRole, repoOutcome: undefined })).toBe(true);
    expect(shouldGrantFirstTimeContributorGrace({ enabled: true, roleContext: contributorRole, repoOutcome: newcomerOutcome })).toBe(true);
    expect(shouldGrantFirstTimeContributorGrace({ enabled: true, roleContext: maintainerRoleContext, repoOutcome: newcomerOutcome })).toBe(false);
    expect(shouldGrantFirstTimeContributorGrace({ enabled: true, roleContext: contributorRole, repoOutcome: repeatOffenderOutcome })).toBe(false);
  });

  it("grants grace for low-history contributors with multiple open attempts but no closed-unmerged pattern", () => {
    const contributorRole = { ...maintainerRoleContext, maintainerLane: false, role: "outside_contributor" as const };
    expect(
      shouldGrantFirstTimeContributorGrace({
        enabled: true,
        roleContext: contributorRole,
        repoOutcome: {
          ...newcomerOutcome,
          pullRequests: 2,
          openPullRequests: 2,
          closedPullRequests: 0,
        },
      }),
    ).toBe(true);
    expect(
      shouldGrantFirstTimeContributorGrace({
        enabled: true,
        roleContext: contributorRole,
        repoOutcome: {
          ...newcomerOutcome,
          pullRequests: 3,
          openPullRequests: 3,
          mergedPullRequests: 0,
          closedPullRequests: 0,
        },
      }),
    ).toBe(true);
    expect(
      shouldGrantFirstTimeContributorGrace({
        enabled: true,
        roleContext: contributorRole,
        repoOutcome: {
          ...newcomerOutcome,
          pullRequests: 3,
          openPullRequests: 2,
          mergedPullRequests: 1,
          closedPullRequests: 0,
        },
      }),
    ).toBe(false);
  });

  it("resolves contributor grace gate policy from base policy and contributor context", () => {
    const contributorRole = { ...maintainerRoleContext, maintainerLane: false, role: "outside_contributor" as const };
    const base = {
      linkedIssueGateMode: "block" as const,
      duplicatePrGateMode: "block" as const,
      qualityGateMode: "block" as const,
      qualityGateMinScore: 90,
      readinessScore: 10,
    };

    expect(resolveContributorGraceGatePolicy(base, { firstTimeContributorGrace: false }, { roleContext: contributorRole, repoOutcome: newcomerOutcome })).toEqual(base);
    expect(
      resolveContributorGraceGatePolicy(base, { firstTimeContributorGrace: true }, { roleContext: contributorRole, repoOutcome: newcomerOutcome }),
    ).toEqual(applyFirstTimeContributorGrace(base));
    expect(
      resolveContributorGraceGatePolicy(base, { firstTimeContributorGrace: true }, { roleContext: maintainerRoleContext, repoOutcome: newcomerOutcome }),
    ).toEqual(base);
    expect(
      resolveContributorGraceGatePolicy(base, { firstTimeContributorGrace: true }, { roleContext: contributorRole, repoOutcome: repeatOffenderOutcome }),
    ).toEqual(base);
  });

  it("preserves non-block gate modes when applying grace", () => {
    expect(
      applyFirstTimeContributorGrace({
        linkedIssueGateMode: "off",
        duplicatePrGateMode: "advisory",
        qualityGateMode: "block",
      }),
    ).toEqual({
      linkedIssueGateMode: "off",
      duplicatePrGateMode: "advisory",
      qualityGateMode: "advisory",
    });
  });

  it("downgrades configured block gates to advisory for newcomers with borderline findings", () => {
    const advisory = {
      targetType: "pull_request" as const,
      targetKey: "JSONbored/gittensory#12",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 12,
      conclusion: "neutral" as const,
      severity: "warning" as const,
      title: "Pull request advisory generated.",
      summary: "Pull request advisory generated.",
      findings: [
        {
          code: "missing_linked_issue",
          severity: "warning" as const,
          title: "No linked issue",
          detail: "Private detail",
        },
      ],
      generatedAt: "2026-06-12T00:00:00.000Z",
      id: "advisory:test",
    };

    const strictGate = evaluateGateCheck(advisory, {
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "block",
      qualityGateMode: "block",
      qualityGateMinScore: 90,
      readinessScore: 10,
    });
    expect(strictGate.conclusion).toBe("failure");

    const gracedGate = evaluateGateCheck(
      advisory,
      applyFirstTimeContributorGrace({
        linkedIssueGateMode: "block",
        duplicatePrGateMode: "block",
        qualityGateMode: "block",
        qualityGateMinScore: 90,
        readinessScore: 10,
      }),
    );
    expect(gracedGate.conclusion).toBe("success");
  });
});

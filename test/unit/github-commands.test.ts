import { describe, expect, it } from "vitest";
import {
  buildPublicAgentCommandComment,
  isAuthorizedCommandActor,
  parseGittensoryMentionCommand,
  sanitizePublicComment,
} from "../../src/github/commands";

describe("GitHub mention commands", () => {
  it("parses only explicit @gittensory commands", () => {
    expect(parseGittensoryMentionCommand(null)).toBeNull();
    expect(parseGittensoryMentionCommand("@gittensory")?.name).toBe("help");
    expect(parseGittensoryMentionCommand("@gittensory preflight")?.name).toBe("preflight");
    expect(parseGittensoryMentionCommand("please @gittensory duplicate-check now")?.name).toBe("duplicate-check");
    expect(parseGittensoryMentionCommand("@gittensory unknown")?.name).toBe("help");
    expect(parseGittensoryMentionCommand("gittensory preflight")).toBeNull();
  });

  it("authorizes maintainers and confirmed miner PR authors only", () => {
    expect(isAuthorizedCommandActor({ commenterLogin: "reviewer", commenterAssociation: "OWNER" })).toMatchObject({
      authorized: true,
      actorKind: "maintainer",
    });
    expect(
      isAuthorizedCommandActor({
        commenterLogin: "oktofeesh1",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "confirmed", snapshot: minerSnapshot() },
      }),
    ).toMatchObject({ authorized: true, reason: "confirmed_miner_pr_author" });
    expect(
      isAuthorizedCommandActor({
        commenterLogin: "oktofeesh1",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "unavailable", error: "api down" },
      }),
    ).toMatchObject({ authorized: false, reason: "miner_detection_unavailable" });
    expect(
      isAuthorizedCommandActor({
        commenterLogin: "oktofeesh1",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "not_found" },
      }),
    ).toMatchObject({ authorized: false, reason: "pr_author_not_confirmed_miner" });
    expect(
      isAuthorizedCommandActor({
        commenterLogin: "other",
        commenterAssociation: "NONE",
        pullRequestAuthorLogin: "oktofeesh1",
        officialAuthorDetection: { status: "confirmed", snapshot: minerSnapshot() },
      }),
    ).toMatchObject({ authorized: false, reason: "not_maintainer_or_pr_author" });
  });

  it("keeps public comments sanitized", () => {
    const command = parseGittensoryMentionCommand("@gittensory next-action")!;
    const body = buildPublicAgentCommandComment({
      command,
      repo: null,
      issue: { number: 12, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      officialMiner: minerSnapshot(),
      bundle: {
        run: {
          id: "run-1",
          objective: "plan",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "completed",
          dataQualityStatus: "complete",
          payload: {},
        },
        actions: [
          {
            id: "action-1",
            runId: "run-1",
            actionType: "choose_next_work",
            status: "recommended",
            recommendation: "private recommendation",
            why: [],
            blockedBy: ["estimated score and wallet should be hidden"],
            publicSafeSummary: "Use a narrow PR packet; reward estimate should not leak.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "done",
      },
    });
    expect(body).toContain("<!-- gittensory-agent-command -->");
    expect(body).toContain("Scope: this repository#12");
    expect(body).not.toMatch(/wallet|hotkey|coldkey|estimated score|reward estimate|payout|farming|raw trust score/i);
    expect(sanitizePublicComment("wallet hotkey payout")).not.toMatch(/wallet|hotkey|payout/i);
  });

  it("renders help, miner-context fallback, refresh, and empty-action responses", () => {
    const help = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory help")!,
      repo: null,
      issue: { number: 1, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "maintainer",
    });
    expect(help).toContain("@gittensory duplicate-check");

    const minerFallback = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory miner-context")!,
      repo: null,
      issue: { number: 2, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      officialMiner: null,
    });
    expect(minerFallback).toContain("Official miner context is unavailable");

    const minerContext = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory miner-context")!,
      repo: { fullName: "owner/repo" } as any,
      issue: { number: 22, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      officialMiner: minerSnapshot(),
    });
    expect(minerContext).toContain("confirmed by the official Gittensor API");
    expect(minerContext).toContain("Scope: owner/repo#22");

    const refresh = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory blockers")!,
      repo: null,
      issue: { number: 3, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-refresh",
          objective: "refresh",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "needs_snapshot_refresh",
          dataQualityStatus: "unknown",
          payload: {},
        },
        actions: [],
        contextSnapshots: [],
        summary: "refresh",
      },
    });
    expect(refresh).toContain("refreshing the contributor decision snapshot");

    const empty = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory next-action")!,
      repo: null,
      issue: { number: 4, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-empty",
          objective: "empty",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "completed",
          dataQualityStatus: "complete",
          payload: {},
        },
        actions: [],
        contextSnapshots: [],
        summary: "empty",
      },
    });
    expect(empty).toContain("No public-safe action is available");

    const noBundle = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory preflight")!,
      repo: null,
      issue: { number: 44, title: "PR", state: "open", pull_request: {} },
      pullRequest: null,
      actorKind: "author",
    });
    expect(noBundle).toContain("No public-safe action is available");

    const withPrFallbackScope = buildPublicAgentCommandComment({
      command: parseGittensoryMentionCommand("@gittensory next-action")!,
      repo: null,
      issue: { number: 5, title: "PR", state: "open", pull_request: {} },
      pullRequest: { repoFullName: "owner/from-pr" } as any,
      actorKind: "author",
      bundle: {
        run: {
          id: "run-action",
          objective: "action",
          actorLogin: "oktofeesh1",
          surface: "github_comment",
          mode: "copilot",
          status: "completed",
          dataQualityStatus: "complete",
          payload: {},
        },
        actions: [
          {
            id: "action",
            runId: "run-action",
            actionType: "choose_next_work",
            status: "recommended",
            recommendation: "recommendation",
            why: [],
            blockedBy: [],
            publicSafeSummary: "Run local branch preflight first.",
            rerunWhen: "After tests pass.",
            approvalRequired: true,
            safetyClass: "private",
            payload: {},
          },
        ],
        contextSnapshots: [],
        summary: "done",
      },
    });
    expect(withPrFallbackScope).toContain("Scope: owner/from-pr#5");
    expect(withPrFallbackScope).toContain("After tests pass.");
  });
});

function minerSnapshot() {
  return {
    source: "gittensor_api" as const,
    githubId: "123",
    githubUsername: "oktofeesh1",
    isEligible: true,
    credibility: 1,
    eligibleRepoCount: 1,
    issueDiscoveryScore: 0,
    issueTokenScore: 0,
    issueCredibility: 1,
    isIssueEligible: false,
    issueEligibleRepoCount: 0,
    alphaPerDay: 0,
    taoPerDay: 0,
    usdPerDay: 0,
    totals: {
      pullRequests: 3,
      mergedPullRequests: 2,
      openPullRequests: 1,
      closedPullRequests: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 0,
      validSolvedIssues: 0,
    },
    repositories: [],
    pullRequests: [],
    issueLabels: [],
  };
}

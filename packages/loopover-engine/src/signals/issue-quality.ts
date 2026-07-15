/** Issue-quality report builder, extracted from signals/engine.ts for package export (#6057).
 *  Pure scoring over mirrored record types — no host `src/` imports, so @loopover/engine can compile it.
 *  Lane / collision / bounty-lifecycle helpers come from predicted-gate-engine.ts. */

import { nowIso } from "../utils/json.js";
import type {
  BountyLifecycle,
  BountyRecord,
  CollisionCluster,
  CollisionReport,
  IssueQualityReport,
  IssueRecord,
  LaneAdvice,
  PullRequestRecord,
  RecentMergedPullRequestRecord,
  RepositoryRecord,
} from "../types/predicted-gate-types.js";
import {
  BOUNTY_STALE_DAYS,
  bountyIssueKey,
  buildCollisionReport,
  buildLaneAdvice,
  classifyBountyLifecycle,
  indexBountiesByIssue,
} from "./predicted-gate-engine.js";

const ISSUE_QUALITY_REPORT_CAP = 100;

const MAINTAINER_WIP_LABELS = new Set([
  "wip",
  "work in progress",
  "work-in-progress",
  "in progress",
  "in-progress",
  "blocked",
  "on hold",
  "on-hold",
  "draft",
  "do not work",
  "do-not-work",
  "internal",
]);

export type IssueDiscoveryLifecycleState = "open" | "closed_not_solved" | "solved" | "valid_solved" | "stale" | "duplicate" | "invalid";

export type IssueLinkageRecord = {
  status: "raw" | "plausible" | "validated" | "invalid" | "unavailable";
  source: "official_mirror" | "github_cache" | "missing";
  solvedByPullRequests: number[];
  reason: string;
  warnings: string[];
};

export type BountyLinkedPr = {
  number: number;
  state: "open" | "merged" | "closed" | "unknown";
  isActive: boolean;
};

export type BountySourceContext = {
  sourceUrl?: string | null | undefined;
  discoveredAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  observedAt?: string | null | undefined;
  ageDays: number | null;
  freshness: "fresh" | "stale" | "unknown";
};

export type BountyOpportunityContext = {
  id: string;
  lifecycle: BountyLifecycle;
  isActiveOpportunity: boolean;
  fundingStatus: "funded" | "target_only" | "unknown";
  consensusRisk: "low" | "medium" | "high";
  source: BountySourceContext;
  linkedPrs: BountyLinkedPr[];
};

export type IssueQualityIssueEntry = IssueQualityReport["issues"][number] & {
  lifecycle?: IssueDiscoveryLifecycleState | undefined;
  linkage?: IssueLinkageRecord | undefined;
  bounty?: BountyOpportunityContext | undefined;
};

type LifecycleEntry = {
  number: number;
  title: string;
  state: IssueDiscoveryLifecycleState;
  solvedByPullRequests: number[];
  reasons: string[];
};

function daysSince(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isMaintainerAssociation(value: string | null | undefined): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return value?.toLowerCase() === login.toLowerCase();
}

function isMaintainerWipIssue(issue: IssueRecord): boolean {
  return isMaintainerAssociation(issue.authorAssociation) && issue.labels.some((label) => MAINTAINER_WIP_LABELS.has(label.toLowerCase().trim()));
}

function indexPullRequestsByLinkedIssue<T extends { number: number; linkedIssues: number[] }>(pullRequests: T[]): Map<number, T[]> {
  const byIssue = new Map<number, T[]>();
  for (const pr of pullRequests) {
    for (const issueNumber of new Set(pr.linkedIssues)) {
      const bucket = byIssue.get(issueNumber);
      if (bucket) bucket.push(pr);
      else byIssue.set(issueNumber, [pr]);
    }
  }
  return byIssue;
}

function indexCollisionClustersByIssue(clusters: CollisionCluster[]): Map<number, CollisionCluster[]> {
  const byIssue = new Map<number, CollisionCluster[]>();
  for (const cluster of clusters) {
    const issueNumbers = new Set<number>();
    for (const item of cluster.items) if (item.type === "issue") issueNumbers.add(item.number);
    for (const issueNumber of issueNumbers) {
      const bucket = byIssue.get(issueNumber);
      if (bucket) bucket.push(cluster);
      else byIssue.set(issueNumber, [cluster]);
    }
  }
  return byIssue;
}

function resolveLinkedPullRequests<T extends { number: number }>(
  issue: IssueRecord,
  pullRequests: T[],
  byLinkedIssue: Map<number, T[]>,
  byNumber: Map<number, T>,
): T[] {
  const linkingPrs = byLinkedIssue.get(issue.number) ?? [];
  if (issue.linkedPrs.length === 0) return [...linkingPrs];
  const matchedNumbers = new Set<number>(linkingPrs.map((pr) => pr.number));
  let addedBackReference = false;
  for (const prNumber of issue.linkedPrs) {
    if (byNumber.has(prNumber) && !matchedNumbers.has(prNumber)) {
      matchedNumbers.add(prNumber);
      addedBackReference = true;
    }
  }
  if (!addedBackReference) return [...linkingPrs];
  return pullRequests.filter((pr) => matchedNumbers.has(pr.number));
}

function issueLinkageWarnings(status: IssueLinkageRecord["status"]): string[] {
  if (status === "validated") return [];
  if (status === "invalid") return ["Issue linkage should not be treated as multiplier-validated."];
  if (status === "unavailable") return ["Issue linkage data is unavailable; confirm solved-by-PR state before relying on it."];
  if (status === "plausible") return ["Issue linkage is plausible but not solved-by-PR validated yet."];
  return ["Raw issue reference has no solved-by-PR evidence yet."];
}

function buildIssueLinkageRecord(
  issue: IssueRecord,
  lifecycleEntry: LifecycleEntry | undefined,
  linkedPrs: PullRequestRecord[],
  linkedMergedPrs: RecentMergedPullRequestRecord[],
): IssueLinkageRecord {
  const verifiedMergedPrs = linkedPrs.filter((pr) => pr.linkedIssues.includes(issue.number) && (pr.mergedAt || pr.state === "merged"));
  const verifiedRecentMergedPrs = linkedMergedPrs.filter((pr) => pr.linkedIssues.includes(issue.number));
  const solvedByPullRequests = [
    ...new Set([...(lifecycleEntry?.solvedByPullRequests ?? []), ...verifiedMergedPrs.map((pr) => pr.number), ...verifiedRecentMergedPrs.map((pr) => pr.number)]),
  ].sort((left, right) => left - right);
  const linkedWorkCount = linkedPrs.length + linkedMergedPrs.length + issue.linkedPrs.length;
  const lifecycle = lifecycleEntry?.state;
  const status: IssueLinkageRecord["status"] =
    solvedByPullRequests.length > 0 || lifecycle === "solved" || lifecycle === "valid_solved"
      ? "validated"
      : lifecycle === "closed_not_solved" || lifecycle === "duplicate" || lifecycle === "invalid" || issue.state !== "open"
        ? "invalid"
        : linkedWorkCount > 0
          ? "plausible"
          : lifecycle
            ? "raw"
            : "unavailable";
  const issueRef = `#${issue.number}`;
  const reason =
    status === "validated"
      ? `Cached GitHub linkage has solved-by-PR evidence for ${issueRef}${solvedByPullRequests.length > 0 ? ` via ${solvedByPullRequests.map((number) => `#${number}`).join(", ")}` : ""}.`
      : status === "invalid"
        ? `Cached GitHub linkage marks ${issueRef} as ${lifecycle?.replace(/_/g, " ") ?? issue.state}.`
        : status === "plausible"
          ? `Cached GitHub linkage has PR context for ${issueRef}, but no solved-by-PR evidence yet.`
          : status === "unavailable"
            ? `No cached linkage state was available for ${issueRef}.`
            : `Cached GitHub linkage has only a raw issue reference for ${issueRef}.`;
  return {
    status,
    source: status === "unavailable" ? "missing" : "github_cache",
    solvedByPullRequests,
    reason,
    warnings: issueLinkageWarnings(status),
  };
}

function classifyIssueDiscoveryLifecycle(
  issue: IssueRecord,
  pullRequests: PullRequestRecord[],
  recentMergedPullRequests: RecentMergedPullRequestRecord[],
  lane: LaneAdvice,
  linkedIndex?: { open: Map<number, PullRequestRecord[]>; merged: Map<number, RecentMergedPullRequestRecord[]> },
): LifecycleEntry {
  const linkedOpenPrs = linkedIndex ? (linkedIndex.open.get(issue.number) ?? []) : pullRequests.filter((pr) => pr.linkedIssues.includes(issue.number));
  const linkedMergedPrs = linkedIndex
    ? (linkedIndex.merged.get(issue.number) ?? [])
    : recentMergedPullRequests.filter((pr) => pr.linkedIssues.includes(issue.number));
  const mergedSolverPrs = [...linkedOpenPrs.filter((pr) => pr.mergedAt || pr.state === "merged"), ...linkedMergedPrs];
  const solvedByPullRequests = [...new Set(mergedSolverPrs.map((pr) => pr.number))].sort((left, right) => left - right);
  const issueAuthorLogin = issue.authorLogin;
  const selfSolvedLoop = Boolean(issueAuthorLogin && mergedSolverPrs.length > 0 && mergedSolverPrs.every((pr) => sameLogin(pr.authorLogin, issueAuthorLogin)));
  const labels = issue.labels.map((label) => label.toLowerCase());
  const stale = daysSince(issue.updatedAt ?? issue.createdAt) > 90;
  const duplicate = labels.some((label) => /duplicate/.test(label));
  const invalid = labels.some((label) => /invalid|wontfix|not planned|won't fix/.test(label));
  const state: IssueDiscoveryLifecycleState = duplicate
    ? "duplicate"
    : invalid
      ? "invalid"
      : solvedByPullRequests.length > 0
        ? (lane.lane === "issue_discovery" || lane.lane === "split") && !selfSolvedLoop
          ? "valid_solved"
          : "solved"
        : issue.state !== "open"
          ? "closed_not_solved"
          : stale
            ? "stale"
            : "open";
  const reasons = [
    ...(duplicate ? ["Issue carries duplicate labeling."] : []),
    ...(invalid ? ["Issue carries invalid or not-planned labeling."] : []),
    ...(solvedByPullRequests.length > 0 ? [`Linked solver PR(s): ${solvedByPullRequests.map((number) => `#${number}`).join(", ")}.`] : []),
    ...(selfSolvedLoop ? ["Linked solver PR author matches the issue reporter; cache treats this as solved but not valid issue-discovery evidence."] : []),
    ...(issue.state !== "open" && solvedByPullRequests.length === 0 ? ["Issue is closed without cached solver PR evidence."] : []),
    ...(stale && issue.state === "open" ? ["Issue is stale in cached metadata."] : []),
    ...(lane.lane === "direct_pr" ? ["Repo is direct-PR first; lifecycle should not encourage issue filing."] : []),
  ];
  return { number: issue.number, title: issue.title, state, solvedByPullRequests, reasons: reasons.length > 0 ? reasons : ["Issue is open with no solver or duplicate signal."] };
}

function buildBountySourceContext(bounty: BountyRecord): BountySourceContext {
  const observedAt = bounty.updatedAt ?? bounty.discoveredAt ?? null;
  const ageDays = observedAt ? daysSince(observedAt) : null;
  return {
    sourceUrl: bounty.sourceUrl ?? null,
    discoveredAt: bounty.discoveredAt ?? null,
    updatedAt: bounty.updatedAt ?? null,
    observedAt,
    ageDays,
    freshness: ageDays === null ? "unknown" : ageDays > BOUNTY_STALE_DAYS ? "stale" : "fresh",
  };
}

function buildBountyLinkedPrs(
  issue: IssueRecord | null,
  pullRequests: PullRequestRecord[],
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): BountyLinkedPr[] {
  if (!issue) return [];
  const linkedNumbers = new Set<number>(issue.linkedPrs);
  for (const pr of pullRequests) {
    if (pr.linkedIssues.includes(issue.number)) linkedNumbers.add(pr.number);
  }
  for (const pr of recentMergedPullRequests) {
    if (pr.linkedIssues.includes(issue.number)) linkedNumbers.add(pr.number);
  }
  const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));
  const recentMergedByNumber = new Set(recentMergedPullRequests.map((pr) => pr.number));
  return [...linkedNumbers]
    .sort((left, right) => left - right)
    .map((number) => {
      const pr = byNumber.get(number);
      const state: BountyLinkedPr["state"] = recentMergedByNumber.has(number)
        ? "merged"
        : !pr
          ? "unknown"
          : pr.mergedAt
            ? "merged"
            : pr.state === "open"
              ? "open"
              : "closed";
      return { number, state, isActive: state === "open" };
    });
}

function computeBountyConsensusRisk(
  lifecycle: BountyLifecycle,
  issue: IssueRecord | null,
  open: number,
  merged: number,
  closed: number,
  unknown: number,
): BountyOpportunityContext["consensusRisk"] {
  if (open > 1) return "high";
  if (lifecycle === "active" && !issue) return "high";
  if (open === 1 || merged > 0 || closed > 1 || unknown > 1) return "medium";
  return "low";
}

/** Slim bounty opportunity context — same fields as engine.ts's advisory-derived shape, without SignalFinding side effects. */
function buildBountyOpportunityContext(
  bounty: BountyRecord,
  issue: IssueRecord | null,
  pullRequests: PullRequestRecord[] = [],
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): BountyOpportunityContext {
  const lifecycle = classifyBountyLifecycle(bounty, issue);
  const target = bounty.payload.target_bounty ?? bounty.payload.target_alpha;
  const amount = bounty.payload.bounty_amount ?? bounty.payload.bounty_alpha;
  const fundingStatus: BountyOpportunityContext["fundingStatus"] =
    amount && amount !== 0 && amount !== "0.0000" ? "funded" : target ? "target_only" : "unknown";
  const linkedPrs = buildBountyLinkedPrs(issue, pullRequests, recentMergedPullRequests);
  const open = linkedPrs.filter((pr) => pr.state === "open").length;
  const merged = linkedPrs.filter((pr) => pr.state === "merged").length;
  const closed = linkedPrs.filter((pr) => pr.state === "closed").length;
  const unknown = linkedPrs.filter((pr) => pr.state === "unknown").length;
  return {
    id: bounty.id,
    lifecycle,
    isActiveOpportunity: lifecycle === "active",
    fundingStatus,
    consensusRisk: computeBountyConsensusRisk(lifecycle, issue, open, merged, closed, unknown),
    source: buildBountySourceContext(bounty),
    linkedPrs,
  };
}

export function buildIssueQualityReport(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
  bounties: BountyRecord[] = [],
  prebuiltCollisions?: CollisionReport,
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): IssueQualityReport {
  const lane = buildLaneAdvice(repo, fullName);
  const collisions = prebuiltCollisions ?? buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
  const bountyByIssue = indexBountiesByIssue(bounties);
  const prsByLinkedIssue = indexPullRequestsByLinkedIssue(pullRequests);
  const prByNumber = new Map(pullRequests.map((pr) => [pr.number, pr] as const));
  const mergedPrsByLinkedIssue = indexPullRequestsByLinkedIssue(recentMergedPullRequests);
  const mergedPrByNumber = new Map(recentMergedPullRequests.map((pr) => [pr.number, pr] as const));
  const clustersByIssue = indexCollisionClustersByIssue(collisions.clusters);
  const linkedIndex = { open: prsByLinkedIssue, merged: mergedPrsByLinkedIssue };
  const lifecycleByIssue = new Map(
    issues.map((issue) => [issue.number, classifyIssueDiscoveryLifecycle(issue, pullRequests, recentMergedPullRequests, lane, linkedIndex)] as const),
  );
  const reports: IssueQualityIssueEntry[] = issues
    .filter((issue) => issue.state === "open")
    .map((issue) => {
      const linkedPrs = resolveLinkedPullRequests(issue, pullRequests, prsByLinkedIssue, prByNumber);
      const linkedMergedPrs = resolveLinkedPullRequests(issue, recentMergedPullRequests, mergedPrsByLinkedIssue, mergedPrByNumber);
      const issueCollisions = clustersByIssue.get(issue.number) ?? [];
      const age = daysSince(issue.updatedAt ?? issue.createdAt);
      const lifecycleEntry = lifecycleByIssue.get(issue.number);
      const lifecycle = lifecycleEntry?.state ?? "open";
      const bodyLength = issue.body?.trim().length ?? 0;
      const bounty = bountyByIssue.get(bountyIssueKey(fullName, issue.number)) ?? null;
      const bountyLifecycle = bounty ? classifyBountyLifecycle(bounty, issue) : null;
      const bountyContext = bounty ? buildBountyOpportunityContext(bounty, issue, linkedPrs, linkedMergedPrs) : undefined;
      const linkedWorkCount = linkedPrs.length + linkedMergedPrs.length + issue.linkedPrs.length;
      const linkage = buildIssueLinkageRecord(issue, lifecycleEntry, linkedPrs, linkedMergedPrs);
      const maintainerAuthored = isMaintainerAssociation(issue.authorAssociation);
      const maintainerWip = isMaintainerWipIssue(issue);
      const reasons = [
        ...(bodyLength >= 200 ? ["Issue has enough body detail to evaluate."] : []),
        ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(", ")}.`] : []),
        ...(linkedWorkCount === 0 ? ["No active PR is linked in cached metadata."] : []),
        ...(bountyLifecycle === "active" ? ["Active bounty context is attached (contribution context, not guaranteed payout)."] : []),
      ];
      const warnings = [
        ...(bodyLength < 80 ? ["Issue body is thin; contributor may need more proof before acting."] : []),
        ...(linkedPrs.length > 0 ? [`${linkedPrs.length} active PR(s) already reference this issue.`] : []),
        ...(linkedMergedPrs.length > 0 ? [`${linkedMergedPrs.length} merged PR(s) already reference this issue.`] : []),
        ...(issue.linkedPrs.length > 0 && linkedPrs.length === 0 && linkedMergedPrs.length === 0
          ? [`Cached issue metadata already references PR(s): ${issue.linkedPrs.map((number) => `#${number}`).join(", ")}.`]
          : []),
        ...(issueCollisions.length > 0 ? ["Potential duplicate or overlapping issue/PR context exists."] : []),
        ...(age > 90 ? ["Issue is stale in cached metadata."] : []),
        ...(lifecycle !== "open" ? [`Issue lifecycle is ${lifecycle.replace(/_/g, " ")}.`] : []),
        ...(lane.lane === "direct_pr" ? ["Repo is direct-PR first; issue filing is not the primary Gittensor lane."] : []),
        ...(bountyLifecycle === "completed" ? ["A completed bounty is attached; the work is likely already solved, not an open opportunity."] : []),
        ...(bountyLifecycle === "cancelled" ? ["A cancelled bounty is attached; this is not an active opportunity."] : []),
        ...(bountyLifecycle === "historical"
          ? ["Historical bounty context is attached; this is not an active opportunity without upstream confirmation."]
          : []),
        ...(bountyLifecycle === "stale" ? ["Bounty context for this issue looks stale; confirm it is still active before acting."] : []),
        ...(bountyLifecycle === "ambiguous" ? ["Bounty state for this issue is ambiguous; verify it before acting."] : []),
        ...(maintainerAuthored && !maintainerWip ? ["Maintainer-authored; confirm it is open for outside contribution before starting."] : []),
        ...(maintainerWip
          ? ["Maintainer-authored and labelled in-progress/internal; not a recommended outside-contributor target without confirmation."]
          : []),
      ];
      const score = clamp(100 - warnings.length * 18 + reasons.length * 5 - (age > 180 ? 15 : 0), 0, 100);
      const bountyBlocks = bountyLifecycle === "completed" || bountyLifecycle === "cancelled" || bountyLifecycle === "historical";
      const bountyCaution = bountyLifecycle === "stale" || bountyLifecycle === "ambiguous";
      const status: IssueQualityReport["issues"][number]["status"] =
        linkedWorkCount > 0 ||
        issueCollisions.some((cluster) => cluster.risk === "high") ||
        bountyBlocks ||
        ["duplicate", "invalid", "solved", "valid_solved"].includes(lifecycle)
          ? "do_not_use"
          : maintainerWip || warnings.some((warning) => /thin|stale|direct-PR/i.test(warning)) || bountyCaution || lifecycle === "stale"
            ? "needs_proof"
            : score < 45
              ? "hold"
              : "ready";
      return { number: issue.number, title: issue.title, lifecycle, linkage, bounty: bountyContext, status, score, reasons, warnings };
    })
    .sort((left, right) => right.score - left.score || left.number - right.number)
    .slice(0, ISSUE_QUALITY_REPORT_CAP);
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    lane,
    issues: reports,
    summary: `${reports.length} open issue(s) evaluated; ${reports.filter((report) => report.status === "ready").length} look ready from cached metadata.`,
  };
}

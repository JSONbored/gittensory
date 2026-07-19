import {
  DEFAULT_MINER_GOAL_SPEC,
  parseMinerGoalSpecContent,
  rankMetadataOpportunities,
} from "@loopover/engine";
import type { MetadataRankContext, MinerGoalSpec } from "@loopover/engine";
import type { RawCandidateIssue } from "./opportunity-fanout.js";

export type RankedCandidateIssue = RawCandidateIssue & {
  potential: number;
  feasibility: number;
  laneFit: number;
  freshness: number;
  dupRisk: number;
  rankScore: number;
};

export type RankCandidateIssuesOptions = {
  nowMs?: number;
  highRiskDuplicateClusters?: number;
  openPullRequests?: number;
  goalSpecsByRepo?: Record<string, MinerGoalSpec>;
  goalSpecContentByRepo?: Record<string, string>;
};

export type RankedCandidateSummary = {
  issues: RankedCandidateIssue[];
  skippedInvalid: number;
  usedDefaultGoalSpec: boolean;
  defaultGoalSpec: MinerGoalSpec;
};

/** Internal metadata-only candidate shape produced by {@link normalizeCandidate}; satisfies the engine's
 *  `MetadataCandidateIssue` constraint that `rankMetadataOpportunities` ranks over. */
type NormalizedCandidate = {
  owner: string;
  repo: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: string[];
  commentsCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  htmlUrl: string | null;
  aiPolicyAllowed: boolean;
  aiPolicySource: "AI-USAGE.md" | "CONTRIBUTING.md" | "none";
};

function finiteEpochMs(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : Date.now();
}

function finiteNonNegativeInt(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function normalizeCandidate(candidate: unknown): NormalizedCandidate | null {
  if (!candidate || typeof candidate !== "object") return null;
  const c = candidate as Record<string, unknown>;
  const repoFullName =
    typeof c.repoFullName === "string" ? c.repoFullName.trim() : "";
  const issueNumber = c.issueNumber;
  const title = typeof c.title === "string" ? c.title.trim() : "";
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!Number.isInteger(issueNumber) || (issueNumber as number) <= 0 || !title) return null;
  const canonicalRepoFullName = `${owner}/${repo}`;
  const labels = Array.isArray(c.labels)
    ? c.labels
        .filter((label) => typeof label === "string" && label.trim())
        .map((label) => label.trim())
    : [];
  return {
    owner,
    repo,
    repoFullName: canonicalRepoFullName,
    issueNumber: issueNumber as number,
    title,
    labels,
    commentsCount: Number.isFinite(c.commentsCount) ? (c.commentsCount as number) : 0,
    createdAt: typeof c.createdAt === "string" ? c.createdAt : null,
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : null,
    htmlUrl: typeof c.htmlUrl === "string" ? c.htmlUrl : null,
    aiPolicyAllowed: c.aiPolicyAllowed !== false,
    aiPolicySource:
      c.aiPolicySource === "AI-USAGE.md" ||
      c.aiPolicySource === "CONTRIBUTING.md" ||
      c.aiPolicySource === "none"
        ? c.aiPolicySource
        : "none",
  };
}

function buildGoalSpecsByRepo(options: RankCandidateIssuesOptions = {}): Record<string, MinerGoalSpec> {
  const goalSpecsByRepo: Record<string, MinerGoalSpec> = { ...(options.goalSpecsByRepo ?? {}) };
  const rawContentByRepo = options.goalSpecContentByRepo ?? {};
  for (const [repoFullName, content] of Object.entries(rawContentByRepo)) {
    if (typeof content !== "string" || !content.trim()) continue;
    goalSpecsByRepo[repoFullName] = parseMinerGoalSpecContent(content).spec;
  }
  return goalSpecsByRepo;
}

function buildRankContext(options: RankCandidateIssuesOptions = {}): MetadataRankContext {
  return {
    nowMs: finiteEpochMs(options.nowMs),
    highRiskDuplicateClusters: finiteNonNegativeInt(options.highRiskDuplicateClusters),
    openPullRequests: finiteNonNegativeInt(options.openPullRequests),
    goalSpecsByRepo: buildGoalSpecsByRepo(options),
  };
}

function collectCandidates(candidates: unknown): {
  normalized: NormalizedCandidate[];
  skippedInvalid: number;
} {
  const input = Array.isArray(candidates) ? candidates : [];
  let skippedInvalid = 0;
  const normalized: NormalizedCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of input) {
    const entry = normalizeCandidate(candidate);
    if (!entry) {
      skippedInvalid += 1;
      continue;
    }
    const key = `${entry.repoFullName.toLowerCase()}#${entry.issueNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  return { normalized, skippedInvalid };
}

function rankedUsesDefaultGoalSpec(
  ranked: RankedCandidateIssue[],
  options: RankCandidateIssuesOptions = {},
): boolean {
  const goalSpecsByRepo = buildGoalSpecsByRepo(options);
  const specRepos = Object.keys(goalSpecsByRepo);
  if (ranked.length === 0) return specRepos.length === 0;
  // The "ranked with the built-in default goal spec (no per-tenant .loopover-miner.yml supplied)" note is only
  // truthful when the WHOLE batch fell back to the default -- so require EVERY ranked repo to lack a supplied spec,
  // not just any one of them (#7226). With `.some`, a single spec-less repo made a mixed batch (where other repos
  // genuinely had a spec supplied and applied) print the blanket note as if none did.
  return ranked.every((issue) => {
    const target = issue.repoFullName.trim().toLowerCase();
    return !specRepos.some((repo) => repo.trim().toLowerCase() === target);
  });
}

/**
 * Rank metadata-only fan-out candidates locally. Never clones source, never uploads metadata, and never writes to
 * GitHub — it only composes deterministic engine signals and returns the sorted list.
 */
export function rankCandidateIssues(
  candidates: RawCandidateIssue[],
  options: RankCandidateIssuesOptions = {},
): RankedCandidateIssue[] {
  const { normalized } = collectCandidates(candidates);
  return rankMetadataOpportunities(normalized, buildRankContext(options)) as RankedCandidateIssue[];
}

export function rankCandidateIssuesWithSummary(
  candidates: RawCandidateIssue[],
  options: RankCandidateIssuesOptions = {},
): RankedCandidateSummary {
  const { normalized, skippedInvalid } = collectCandidates(candidates);
  const ranked = rankMetadataOpportunities(normalized, buildRankContext(options)) as RankedCandidateIssue[];
  return {
    issues: ranked,
    skippedInvalid,
    usedDefaultGoalSpec: rankedUsesDefaultGoalSpec(ranked, options),
    defaultGoalSpec: DEFAULT_MINER_GOAL_SPEC,
  };
}

export type FreshnessIssue = {
  state: string;
  updatedAt?: string | null;
  createdAt?: string | null;
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isParseableTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function pickTimestamp(issue: FreshnessIssue): string | null {
  const updated = typeof issue.updatedAt === "string" ? issue.updatedAt.trim() : "";
  if (updated && isParseableTimestamp(updated)) return updated;

  const created = typeof issue.createdAt === "string" ? issue.createdAt.trim() : "";
  if (created && isParseableTimestamp(created)) return created;

  return null;
}

// An open issue whose timestamp is missing or unparseable is treated as maximally STALE, not fresh: a
// malformed row must not rank ahead of genuinely fresh opportunities in the metadata ranker. This restores
// the flooring introduced with this scorer (#2806, "invalid or missing issue timestamps floor freshness
// instead of ranking malformed metadata first"). exp(-STALE_AGE_DAYS / 20) underflows to ~0, which the
// clamp raises to the 0.05 freshness floor.
const STALE_AGE_DAYS = 9999;

function issueAgeDays(value: string | null, nowMs: number): number {
  if (!value) return STALE_AGE_DAYS;
  const parsed = Date.parse(value);
  /* v8 ignore next -- pickTimestamp only ever yields a parseable string or null; kept as a defensive floor. */
  if (!Number.isFinite(parsed)) return STALE_AGE_DAYS;
  return Math.floor((nowMs - parsed) / 86_400_000);
}

function isOpenIssue(issue: FreshnessIssue): boolean {
  return typeof issue?.state === "string" && issue.state.trim().toLowerCase() === "open";
}

/* v8 ignore start -- Test-only export surface for branch coverage. */
export const opportunityFreshnessInternals = {
  pickTimestamp,
  issueAgeDays,
};
/* v8 ignore stop */

/**
 * Compute a [0.05, 1] freshness factor from open issue timestamps, mirroring
 * `opportunityFreshnessFactor` in `src/signals/reward-risk.ts` with an injected clock so the miner engine
 * stays pure and testable.
 */
export function computeOpportunityFreshness(
  issues: readonly FreshnessIssue[],
  nowMs: number,
): number {
  /* v8 ignore next -- Caller supplies a finite epoch; non-finite clocks degrade to zero freshness. */
  if (!Number.isFinite(nowMs)) return 0;
  const openIssues = issues.filter(isOpenIssue);
  if (openIssues.length === 0) return 0;

  let mostRecentAgeDays = Number.POSITIVE_INFINITY;
  for (const issue of openIssues) {
    const ageDays = issueAgeDays(pickTimestamp(issue), nowMs);
    if (ageDays < mostRecentAgeDays) mostRecentAgeDays = ageDays;
  }

  return round4(clamp(Math.exp(-mostRecentAgeDays / 20), 0.05, 1));
}

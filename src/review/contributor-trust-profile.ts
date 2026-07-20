// Per-contributor trust profile (#fairness-analytics, private/internal-only): composes THREE already-existing
// data sources into one queryable view, per repo -- nothing here is a new signal, it's a new lens on data this
// codebase already collects:
//   - submitter_stats (migration 0046) -- raw per-(project, submitter) submission/merge/close counts.
//   - moderation violations (audit_events, MODERATION_VIOLATION_EVENT_TYPE) -- adverse actions/warnings already
//     recorded by the moderation-rules engine (src/services/agent-action-executor.ts).
//   - computeContributorGateEval (contributor-gate-eval.ts) -- per-repo gate-decision accuracy.
//
// SCOPE (inherits contributor-gate-eval.ts's design note verbatim): NEVER rendered on any public surface.
// Internal/bearer-gated consumers only.

import { MODERATION_VIOLATION_EVENT_TYPE } from "../settings/moderation-rules";
import { listModerationViolationsForActor } from "../db/repositories";
import { computeContributorGateEval } from "./contributor-gate-eval";
import { resolveEligibleFairnessAnalyticsProjects } from "./contributor-trust-profile-wire";
import { nowIso } from "../utils/json";

const ALL_MODERATION_EVENT_TYPES = Object.values(MODERATION_VIOLATION_EVENT_TYPE);
/** Below this many days between a contributor's first and most recent violation on a repo, a "per month" rate
 *  is too noisy to publish (a single burst reads as an absurd rate over a near-zero span). */
const MIN_VIOLATION_SPAN_DAYS_FOR_RATE = 7;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30;

export interface ContributorRepoStats {
  project: string;
  submissions: number;
  merged: number;
  closed: number;
  manual: number;
  lastSeen: string | null;
}

export interface ContributorModerationSummary {
  project: string;
  violationCount: number;
  /** Distinct moderation rule types seen on this repo (e.g. ["contributor_cap", "review_nag"]). */
  ruleTypes: string[];
  firstViolationAt: string;
  lastViolationAt: string;
  /** violationCount / (span in months), where span = lastViolationAt - firstViolationAt. Null with fewer than
   *  2 violations or a span under MIN_VIOLATION_SPAN_DAYS_FOR_RATE -- a rate needs at least two points spread
   *  over a real window to mean anything. */
  ratePerMonth: number | null;
}

export interface ContributorTrustProfile {
  login: string;
  generatedAt: string;
  windowDays: number;
  repoStats: ContributorRepoStats[];
  moderation: ContributorModerationSummary[];
  gateAccuracy: Array<{ project: string; decided: number; weightedAccuracy: number | null }>;
  totals: { submissions: number; merged: number; closed: number; violations: number };
}

/** Raw per-project submitter_stats rows for one submitter -- submitter_stats has no existing multi-project
 *  reader (submitter-reputation.ts's own readers are all single-project). Fail-safe -> []. */
async function loadContributorRepoStats(env: Env, login: string): Promise<ContributorRepoStats[]> {
  try {
    const res = await env.DB.prepare(
      `SELECT project, submissions, merged, closed, manual, last_seen AS lastSeen
         FROM submitter_stats WHERE submitter = ?
        ORDER BY project ASC`,
    )
      .bind(login)
      .all<{ project: string; submissions: number; merged: number; closed: number; manual: number; lastSeen: string | null }>();
    return (res.results ?? []).map((r) => ({
      project: r.project,
      // submissions/merged/closed/manual are all `INTEGER NOT NULL DEFAULT 0` on submitter_stats (migration
      // 0046); the SQL engine itself rules out a null read here. Each `?? 0` below exists only to satisfy the
      // D1 driver's generic (nullable) row typing -- v8-ignored individually since only single-line ignores
      // are honored here.
      /* v8 ignore next */
      submissions: r.submissions ?? 0,
      /* v8 ignore next */
      merged: r.merged ?? 0,
      /* v8 ignore next */
      closed: r.closed ?? 0,
      /* v8 ignore next */
      manual: r.manual ?? 0,
      lastSeen: r.lastSeen ?? null,
    }));
  } catch {
    return [];
  }
}

/** Folds listModerationViolationsForActor's flat rows into one summary per repo. Pure -- no I/O. */
export function summarizeModerationViolationsByRepo(
  rows: Array<{ repoFullName: string; eventType: string; createdAt: string }>,
): ContributorModerationSummary[] {
  const byRepo = new Map<string, { eventTypes: Set<string>; timestamps: number[] }>();
  for (const r of rows) {
    if (!r.repoFullName) continue; // malformed metadata (see listModerationViolationsForActor) -- unattributable
    const bucket = byRepo.get(r.repoFullName) ?? { eventTypes: new Set<string>(), timestamps: [] };
    bucket.eventTypes.add(r.eventType);
    const ms = Date.parse(r.createdAt);
    if (Number.isFinite(ms)) bucket.timestamps.push(ms);
    byRepo.set(r.repoFullName, bucket);
  }

  const summaries: ContributorModerationSummary[] = [];
  for (const [project, bucket] of byRepo) {
    if (bucket.timestamps.length === 0) continue; // every row had an unparseable createdAt -- nothing to report
    bucket.timestamps.sort((a, b) => a - b);
    const firstMs = bucket.timestamps[0]!;
    const lastMs = bucket.timestamps[bucket.timestamps.length - 1]!;
    const spanDays = (lastMs - firstMs) / MS_PER_DAY;
    const ratePerMonth =
      bucket.timestamps.length >= 2 && spanDays >= MIN_VIOLATION_SPAN_DAYS_FOR_RATE
        ? Math.round((bucket.timestamps.length / (spanDays / DAYS_PER_MONTH)) * 10) / 10
        : null;
    summaries.push({
      project,
      violationCount: bucket.timestamps.length,
      ruleTypes: [...bucket.eventTypes].sort(),
      firstViolationAt: new Date(firstMs).toISOString(),
      lastViolationAt: new Date(lastMs).toISOString(),
      ratePerMonth,
    });
  }
  summaries.sort((a, b) => a.project.localeCompare(b.project));
  return summaries;
}

/**
 * Assemble one contributor's cross-repo trust profile from the three existing sources described in this file's
 * header. Fail-safe throughout -- each source degrades independently to [] rather than failing the whole
 * profile, matching computeFleetAnalytics/computeContributorGateEval's own stance.
 */
export async function getContributorTrustProfile(env: Env, login: string, opts: { days?: number; nowMs?: number } = {}): Promise<ContributorTrustProfile> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowDays = Number.isFinite(opts.days) && (opts.days as number) > 0 ? Math.min(opts.days as number, 730) : 90;

  const [rawRepoStats, violationRows, gateEval] = await Promise.all([
    loadContributorRepoStats(env, login),
    listModerationViolationsForActor(env, login, ALL_MODERATION_EVENT_TYPES).catch(() => []),
    // computeContributorGateEval already applies the same per-repo opt-out filter below internally.
    computeContributorGateEval(env, { days: windowDays, nowMs, login }),
  ]);

  const rawModeration = summarizeModerationViolationsByRepo(violationRows);
  // Config-as-code (#fairness-analytics): apply the SAME per-repo opt-out (settings.fairnessAnalyticsMode: off)
  // to repoStats/moderation that computeContributorGateEval already applies to gateAccuracy -- resolved once
  // over the union of projects appearing in either source, so a repo can't opt its gate-accuracy rows out while
  // its raw submission counts or moderation history still leak into the same profile.
  const eligibleProjects = await resolveEligibleFairnessAnalyticsProjects(env, [...rawRepoStats.map((r) => r.project), ...rawModeration.map((m) => m.project)]);
  const repoStats = rawRepoStats.filter((r) => eligibleProjects.has(r.project));
  const moderation = rawModeration.filter((m) => eligibleProjects.has(m.project));
  const gateAccuracy = gateEval.rows.map((r) => ({ project: r.project, decided: r.decided, weightedAccuracy: r.weightedAccuracy }));

  const totals = repoStats.reduce(
    (acc, r) => ({ submissions: acc.submissions + r.submissions, merged: acc.merged + r.merged, closed: acc.closed + r.closed, violations: acc.violations }),
    { submissions: 0, merged: 0, closed: 0, violations: moderation.reduce((sum, m) => sum + m.violationCount, 0) },
  );

  return { login, generatedAt: nowIso(), windowDays, repoStats, moderation, gateAccuracy, totals };
}

// Per-contributor gate-decision accuracy + fairness outliers (#fairness-analytics, private/internal-only).
//
// computeContributorGateEval mirrors computeGateEval (src/review/parity.ts) EXACTLY -- same SQL fold, same
// REVERSAL_DISCOUNT_WEIGHT-weighted credit, same ground truth (review_audit's pr_outcome +
// reversal_reverted/reversal_reopened) -- so "correct" means the identical thing at the per-login grain as it
// already does at the per-project grain. The only structural difference is the PREDICTION side: it reads
// contributor_gate_history (login-keyed, migration 0126) instead of review_audit's own gate_decision rows,
// because review_audit is deliberately actor-login-free (see contributor-calibration.ts's design note).
//
// contributorFairnessFlags mirrors gamingPatternFlags (src/orb/analytics.ts #2350) at the per-login grain
// instead of per-instance: multi-condition, minimum-sample-gated, deviation-from-the-PROJECT-median in EITHER
// direction. It never asserts a contributor is gaming anything or that the gate is biased against them --
// both are equally plausible explanations for an outlier, and a human decides which.
//
// computeBlendedContributorGateEval / contributorGlobalFairnessFlags (#global-contributor-trust) fold the SAME
// underlying cells by login ALONE, pooling raw prediction/outcome counts across every project a login has
// touched before computing one precision ratio -- this is volume-weighted, NOT an average of each project's
// weightedAccuracy, so a login mostly active on a high-volume repo isn't distorted by a thin-sample row on a
// second repo (see queryContributorGateCells's own note). This is possible with zero schema changes because
// every one of this owner's self-hosted repos already shares ONE database with no tenant/installation boundary
// column (mirrors packages/loopover-engine/src/settings/global-contributor-cap.ts's identical precedent:
// cross-REPO-within-one-install only, never cross-instance/federated).
//
// SCOPE (read before adding a consumer): this table and anything derived from it -- per-project OR blended --
// must NEVER be rendered on any public surface -- see contributor-calibration.ts's design note, which this
// module inherits verbatim. A blended score is if anything MORE sensitive than any single per-project row (it
// summarizes a login's entire history across every repo in one number), so this constraint applies at least as
// strictly. Consume only via bearer-gated internal routes / the operator dashboard, matching
// contributor_gate_history's own migration-note mandate ("never wire into exportOrbBatch").
//
// CONFIG-AS-CODE (#fairness-analytics): computeContributorGateEval excludes any project whose OWN
// `.loopover.yml` sets `settings.fairnessAnalyticsMode: off` (resolveEligibleFairnessAnalyticsProjects,
// contributor-trust-profile-wire.ts) -- applied here, once, so every consumer (the internal routes, the
// operator dashboard tile, the trust-profile composer) automatically respects a repo's opt-out.

import { REVERSAL_DISCOUNT_WEIGHT } from "./parity";
import { resolveEligibleFairnessAnalyticsProjects } from "./contributor-trust-profile-wire";

export interface ContributorGateEvalRow {
  login: string;
  project: string;
  wouldMerge: number;
  mergeConfirmed: number;
  mergeFalse: number;
  wouldClose: number;
  closeConfirmed: number;
  closeFalse: number;
  decided: number;
  mergePrecision: number | null;
  closePrecision: number | null;
  weightedMergeConfirmed: number;
  weightedCloseConfirmed: number;
  weightedMergePrecision: number | null;
  weightedClosePrecision: number | null;
  /** (weightedMergeConfirmed + weightedCloseConfirmed) / decided -- the single blended number
   *  contributorFairnessFlags compares against the project median. Null when decided is 0. */
  weightedAccuracy: number | null;
}

export interface ContributorGateEvalReport {
  rows: ContributorGateEvalRow[];
  hasSignal: boolean;
}

const MIN_DECIDED_FOR_SIGNAL = 10;

/** Storage seam matching parity.ts's own `storage(env)`. */
function storage(env: Env): D1Database {
  return env.DB;
}

type ContributorGateCell = { login: string; project: string; pred: string; truth: string; reversed: number; n: number };

/**
 * Shared read: contributor_gate_history's predictions joined to review_audit's realized outcome, grouped down
 * to one row per (login, project, pred, truth, reversed) cell -- the finest grain both computeContributorGateEval
 * (folds by login+project) and computeBlendedContributorGateEval (folds by login alone, pooling projects) need.
 * Keeping the SQL in one place guarantees both consumers see the exact same underlying facts; only the
 * in-memory fold differs. Pure read; fail-safe -> []. `opts.login`, when set, scopes the read to one contributor.
 */
async function queryContributorGateCells(env: Env, opts: { days: number; nowMs: number; login?: string }): Promise<ContributorGateCell[]> {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.min(opts.days, 730) : 90;
  const fromIso = new Date(opts.nowMs - days * 86_400_000).toISOString().slice(0, 10);
  const loginFilter = opts.login ? "AND login = ?" : "";
  const sql = `
    WITH cgh AS (
      SELECT login, project, target_id, decision AS pred, MAX(created_at) AS t
      FROM contributor_gate_history WHERE created_at >= ? ${loginFilter}
      GROUP BY login, target_id
    ),
    po AS (
      SELECT target_id, decision AS truth, MAX(created_at) AS t
      FROM review_audit WHERE event_type = 'pr_outcome' AND decision IS NOT NULL
      GROUP BY target_id
    ),
    rev AS (
      SELECT DISTINCT target_id FROM review_audit WHERE event_type IN ('reversal_reverted', 'reversal_reopened')
    )
    SELECT cgh.login AS login, cgh.project AS project, cgh.pred AS pred, po.truth AS truth,
           CASE WHEN rev.target_id IS NOT NULL THEN 1 ELSE 0 END AS reversed, COUNT(*) AS n
    FROM cgh JOIN po ON cgh.target_id = po.target_id
    LEFT JOIN rev ON cgh.target_id = rev.target_id
    GROUP BY cgh.login, cgh.project, cgh.pred, po.truth, reversed`;

  try {
    const stmt = storage(env).prepare(sql);
    const bound = opts.login ? stmt.bind(fromIso, opts.login) : stmt.bind(fromIso);
    const res = await bound.all<ContributorGateCell>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

/**
 * Per-(login, project) gate accuracy over contributor_gate_history's predictions vs review_audit's realized
 * outcome. Pure read; fail-safe -> empty report. Mirrors computeGateEval (parity.ts:92) with `login` added to
 * both the GROUP BY and the fold key -- see this file's header for why the ground-truth join is unchanged.
 * `opts.login`, when set, scopes the read to one contributor (mirrors computeGateEval's own optional `source`/
 * `minerOnly` scoping) -- a single-contributor trust-profile lookup should not fold every other contributor's
 * history just to discard it.
 */
export async function computeContributorGateEval(env: Env, opts: { days: number; nowMs: number; login?: string }): Promise<ContributorGateEvalReport> {
  const cells = await queryContributorGateCells(env, opts);
  if (cells.length === 0) return { rows: [], hasSignal: false };

  const byKey = new Map<string, ContributorGateEvalRow>();
  const row = (login: string, project: string): ContributorGateEvalRow => {
    const key = `${login}:${project}`;
    let r = byKey.get(key);
    if (!r) {
      r = {
        login, project, wouldMerge: 0, mergeConfirmed: 0, mergeFalse: 0, wouldClose: 0, closeConfirmed: 0, closeFalse: 0, decided: 0,
        mergePrecision: null, closePrecision: null, weightedMergeConfirmed: 0, weightedCloseConfirmed: 0, weightedMergePrecision: null, weightedClosePrecision: null, weightedAccuracy: null,
      };
      byKey.set(key, r);
    }
    return r;
  };

  for (const c of cells) {
    const r = row(c.login, c.project);
    r.decided += c.n;
    const weightedN = c.reversed ? c.n * REVERSAL_DISCOUNT_WEIGHT : c.n;
    if (c.pred === "merge") {
      r.wouldMerge += c.n;
      if (c.truth === "merged") {
        r.mergeConfirmed += c.n;
        r.weightedMergeConfirmed += weightedN;
      } else if (c.truth === "closed") r.mergeFalse += c.n;
    } else if (c.pred === "close") {
      r.wouldClose += c.n;
      if (c.truth === "closed") {
        r.closeConfirmed += c.n;
        r.weightedCloseConfirmed += weightedN;
      } else if (c.truth === "merged") r.closeFalse += c.n;
    }
  }

  const folded = [...byKey.values()].map((r) => ({
    ...r,
    mergePrecision: r.wouldMerge > 0 ? r.mergeConfirmed / r.wouldMerge : null,
    closePrecision: r.wouldClose > 0 ? r.closeConfirmed / r.wouldClose : null,
    weightedMergePrecision: r.wouldMerge > 0 ? r.weightedMergeConfirmed / r.wouldMerge : null,
    weightedClosePrecision: r.wouldClose > 0 ? r.weightedCloseConfirmed / r.wouldClose : null,
    weightedAccuracy: r.decided > 0 ? (r.weightedMergeConfirmed + r.weightedCloseConfirmed) / r.decided : null,
  }));

  // Config-as-code (#fairness-analytics): drop any project that opted its own repo out via
  // `settings.fairnessAnalyticsMode: off` in that repo's OWN `.loopover.yml`. A resolution error degrades to
  // "eligible" per project (fail-open, matching resolveRepositorySettings' own DB-default fallback) rather than
  // silently dropping a project's whole row set over an unrelated settings-lookup hiccup.
  const eligibleProjects = await resolveEligibleFairnessAnalyticsProjects(env, folded.map((r) => r.project));
  const rows = folded.filter((r) => eligibleProjects.has(r.project));
  rows.sort((a, b) => a.login.localeCompare(b.login) || a.project.localeCompare(b.project));
  return { rows, hasSignal: rows.some((r) => r.decided >= MIN_DECIDED_FOR_SIGNAL) };
}

export interface ContributorFairnessFlag {
  login: string;
  project: string;
  decided: number;
  weightedAccuracy: number;
  projectMedianAccuracy: number;
  /** weightedAccuracy - projectMedianAccuracy. Positive = unusually FAVORABLE treatment vs peers on this repo;
   *  negative = unusually UNFAVORABLE. Neither direction is asserted as gaming or bias -- flagged for a human
   *  to review either way. */
  deviation: number;
}

const CONTRIBUTOR_MIN_SAMPLE = 5; // mirrors submitter-reputation.ts's own minSample default
const CONTRIBUTOR_OUTLIER_BAND = 0.25; // mirrors orb/analytics.ts's OUTLIER_BAND

/** Shared by contributorFairnessFlags and contributorGlobalFairnessFlags -- both need the median of an
 *  already-nonempty array of weightedAccuracy values. Assumes `values` is sorted ascending. */
function medianOf(values: number[]): number {
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
}

/**
 * Flags (login, project) rows whose weightedAccuracy deviates from that PROJECT's median (across contributors
 * meeting CONTRIBUTOR_MIN_SAMPLE) by more than CONTRIBUTOR_OUTLIER_BAND, in EITHER direction. Pure function --
 * mirrors gamingPatternFlags's stance exactly (src/orb/analytics.ts:210): detection only, never an assertion of
 * fault, never wired into any live gate decision.
 */
export function contributorFairnessFlags(rows: ContributorGateEvalRow[]): ContributorFairnessFlag[] {
  const byProject = new Map<string, ContributorGateEvalRow[]>();
  for (const r of rows) {
    if (r.decided < CONTRIBUTOR_MIN_SAMPLE || r.weightedAccuracy === null) continue;
    const list = byProject.get(r.project) ?? [];
    list.push(r);
    byProject.set(r.project, list);
  }

  const flags: ContributorFairnessFlag[] = [];
  for (const [project, eligible] of byProject) {
    if (eligible.length < 2) continue; // need a peer group to have a meaningful median
    const sorted = eligible.map((r) => r.weightedAccuracy!).sort((a, b) => a - b);
    const projectMedianAccuracy = medianOf(sorted);
    for (const r of eligible) {
      const deviation = r.weightedAccuracy! - projectMedianAccuracy;
      if (Math.abs(deviation) > CONTRIBUTOR_OUTLIER_BAND) {
        flags.push({ login: r.login, project, decided: r.decided, weightedAccuracy: r.weightedAccuracy!, projectMedianAccuracy, deviation });
      }
    }
  }
  flags.sort((a, b) => a.login.localeCompare(b.login) || a.project.localeCompare(b.project));
  return flags;
}

export interface BlendedContributorGateEvalRow {
  login: string;
  /** Distinct fairness-analytics-eligible projects this login has decided rows on, contributing to the blend. */
  projectCount: number;
  wouldMerge: number;
  mergeConfirmed: number;
  mergeFalse: number;
  wouldClose: number;
  closeConfirmed: number;
  closeFalse: number;
  decided: number;
  mergePrecision: number | null;
  closePrecision: number | null;
  weightedMergeConfirmed: number;
  weightedCloseConfirmed: number;
  weightedMergePrecision: number | null;
  weightedClosePrecision: number | null;
  /** Volume-weighted across every eligible project this login has touched -- NOT an average of each project's
   *  own weightedAccuracy (see this file's header). Null when decided is 0. */
  weightedAccuracy: number | null;
}

export interface BlendedContributorGateEvalReport {
  rows: BlendedContributorGateEvalRow[];
  hasSignal: boolean;
}

/**
 * The global, cross-repo blended counterpart to computeContributorGateEval: one row per login, POOLING raw
 * prediction/outcome counts across every fairness-analytics-eligible project that login has touched before
 * computing a single precision ratio -- volume-weighted, not an average of each project's own accuracy, so a
 * login with 400 decided PRs on one repo and 5 on another isn't distorted toward a 50/50 blend of the two
 * projects' figures. Reuses the exact same cells as computeContributorGateEval (queryContributorGateCells) and
 * the exact same REVERSAL_DISCOUNT_WEIGHT-weighted credit semantics. `opts.login`, when set, scopes the read to
 * one contributor (same contract as computeContributorGateEval).
 */
export async function computeBlendedContributorGateEval(env: Env, opts: { days: number; nowMs: number; login?: string }): Promise<BlendedContributorGateEvalReport> {
  const cells = await queryContributorGateCells(env, opts);
  if (cells.length === 0) return { rows: [], hasSignal: false };

  // Config-as-code (#fairness-analytics): apply the per-repo opt-out BEFORE pooling across projects -- an
  // opted-out project's counts must never enter another project's blended precision in the first place, unlike
  // computeContributorGateEval which can filter its already-per-project rows after folding.
  const eligibleProjects = await resolveEligibleFairnessAnalyticsProjects(env, [...new Set(cells.map((c) => c.project))]);
  const eligibleCells = cells.filter((c) => eligibleProjects.has(c.project));

  const byLogin = new Map<string, BlendedContributorGateEvalRow>();
  const projectsByLogin = new Map<string, Set<string>>();
  const row = (login: string): BlendedContributorGateEvalRow => {
    let r = byLogin.get(login);
    if (!r) {
      r = {
        login, projectCount: 0, wouldMerge: 0, mergeConfirmed: 0, mergeFalse: 0, wouldClose: 0, closeConfirmed: 0, closeFalse: 0, decided: 0,
        mergePrecision: null, closePrecision: null, weightedMergeConfirmed: 0, weightedCloseConfirmed: 0, weightedMergePrecision: null, weightedClosePrecision: null, weightedAccuracy: null,
      };
      byLogin.set(login, r);
    }
    return r;
  };

  for (const c of eligibleCells) {
    const r = row(c.login);
    let projects = projectsByLogin.get(c.login);
    if (!projects) {
      projects = new Set<string>();
      projectsByLogin.set(c.login, projects);
    }
    projects.add(c.project);

    r.decided += c.n;
    const weightedN = c.reversed ? c.n * REVERSAL_DISCOUNT_WEIGHT : c.n;
    if (c.pred === "merge") {
      r.wouldMerge += c.n;
      if (c.truth === "merged") {
        r.mergeConfirmed += c.n;
        r.weightedMergeConfirmed += weightedN;
      } else if (c.truth === "closed") r.mergeFalse += c.n;
    } else if (c.pred === "close") {
      r.wouldClose += c.n;
      if (c.truth === "closed") {
        r.closeConfirmed += c.n;
        r.weightedCloseConfirmed += weightedN;
      } else if (c.truth === "merged") r.closeFalse += c.n;
    }
  }

  const rows = [...byLogin.values()].map((r) => ({
    ...r,
    // Every login in byLogin was inserted into projectsByLogin in the SAME loop iteration above -- the two
    // maps always have identical keysets, so this lookup can never miss.
    projectCount: projectsByLogin.get(r.login)!.size,
    mergePrecision: r.wouldMerge > 0 ? r.mergeConfirmed / r.wouldMerge : null,
    closePrecision: r.wouldClose > 0 ? r.closeConfirmed / r.wouldClose : null,
    weightedMergePrecision: r.wouldMerge > 0 ? r.weightedMergeConfirmed / r.wouldMerge : null,
    weightedClosePrecision: r.wouldClose > 0 ? r.weightedCloseConfirmed / r.wouldClose : null,
    weightedAccuracy: r.decided > 0 ? (r.weightedMergeConfirmed + r.weightedCloseConfirmed) / r.decided : null,
  }));
  rows.sort((a, b) => a.login.localeCompare(b.login));
  return { rows, hasSignal: rows.some((r) => r.decided >= MIN_DECIDED_FOR_SIGNAL) };
}

export interface ContributorGlobalFairnessFlag {
  login: string;
  decided: number;
  projectCount: number;
  weightedAccuracy: number;
  fleetMedianAccuracy: number;
  /** weightedAccuracy - fleetMedianAccuracy, across the WHOLE fleet (every eligible repo pooled), not one
   *  project's peers. Positive = unusually FAVORABLE; negative = unusually UNFAVORABLE. Neither direction is
   *  asserted as fault -- flagged for a human to review either way. */
  deviation: number;
}

/**
 * The global counterpart to contributorFairnessFlags: flags logins whose BLENDED (cross-repo) weightedAccuracy
 * deviates from the whole fleet's median (across contributors meeting CONTRIBUTOR_MIN_SAMPLE) by more than
 * CONTRIBUTOR_OUTLIER_BAND, in EITHER direction. A login can be a per-project outlier without being a global
 * outlier (a bad week on one small repo washes out against a long clean history elsewhere) and vice versa --
 * both flag sets exist side by side, neither supersedes the other. Pure function; never an assertion of fault.
 */
export function contributorGlobalFairnessFlags(rows: BlendedContributorGateEvalRow[]): ContributorGlobalFairnessFlag[] {
  const eligible = rows.filter((r) => r.decided >= CONTRIBUTOR_MIN_SAMPLE && r.weightedAccuracy !== null);
  if (eligible.length < 2) return []; // need a peer group to have a meaningful median

  const sorted = eligible.map((r) => r.weightedAccuracy!).sort((a, b) => a - b);
  const fleetMedianAccuracy = medianOf(sorted);

  const flags: ContributorGlobalFairnessFlag[] = [];
  for (const r of eligible) {
    const deviation = r.weightedAccuracy! - fleetMedianAccuracy;
    if (Math.abs(deviation) > CONTRIBUTOR_OUTLIER_BAND) {
      flags.push({ login: r.login, decided: r.decided, projectCount: r.projectCount, weightedAccuracy: r.weightedAccuracy!, fleetMedianAccuracy, deviation });
    }
  }
  flags.sort((a, b) => a.login.localeCompare(b.login));
  return flags;
}

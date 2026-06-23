// Public "proof of power" stats (#1059) — a small, public-safe aggregate of what gittensory's REVIEW SYSTEM has
// done, powering the above-the-fold homepage counter. Flag-gated by GITTENSORY_PUBLIC_STATS (default OFF): when
// off the public endpoint 404s, so the deploy is byte-identical to today until the flag is deliberately set.
//
// REALTIME: queries the live tables directly (no rollup/cron) so a new review shows up within the 60s HTTP cache
// window. review_targets is the HISTORICAL base (one row per PR, terminal DISPOSITION in `status`), but it was
// FROZEN at the agent cutover (gittensory[bot] became the sole reviewer/actor and stopped writing it) — so on
// its own it reads a dead table (RC8). The post-cutover live ledger is audit_events: a review lands as
// github_app.pr_public_surface_published, a merge as agent.action.merge, a close as agent.action.close. We
// therefore UNION the two: the frozen review_targets snapshot PLUS the audit_events that occurred AFTER the
// snapshot freeze point, de-duped by PR so nothing already terminal in the snapshot is double-counted. This is
// NOT the broader pull_requests / recent_merged_pull_requests mining caches.
//
// DISPOSITIONS (terminal): merged / closed = gittensory auto-actioned; commented = reviewed + advised, deferred
// to a maintainer; manual = escalated to a maintainer; ignored = skipped (drafts/bots/excluded); error = failed.
//   reviewed   = merged + closed + commented + manual   (PRs it actually reviewed; excludes ignored + error)
//   filteredPct = (reviewed - merged) / reviewed         (share resolved WITHOUT a merge — noise kept off humans)
//   accuracyPct = 1 - reversed / (merged + closed)       (reversal-grounded; reversed from review_audit)
//   minutesSaved = reviewed * MINUTES_SAVED_PER_PR        (estimated maintainer review time saved)
//
// PRIVACY: counts only — no PR content, authors, scores, or reward internals. Safe to serve publicly.

/** Estimate of maintainer review/triage time saved per reviewed PR. Dial this to taste — it is the single knob
 *  behind the "time saved" stat (at current volume: 20 min ≈ 38 days saved; 15 min ≈ 28 days). */
export const MINUTES_SAVED_PER_PR = 20;

/** Truthy-string flag check, matching ops-wire / selftune-wire. */
export function isPublicStatsEnabled(env: { GITTENSORY_PUBLIC_STATS?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_PUBLIC_STATS ?? "");
}

/** Storage seam: gittensory's `Env` is a global ambient interface with `DB` (mirrors src/review/stats.ts). */
function storage(env: Env): D1Database {
  return env.DB;
}

/** Read-only helper that degrades a missing/empty table (or absent column in some envs) to []. */
async function safeAll<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const prepared = storage(env).prepare(sql);
    const stmt = binds.length > 0 ? prepared.bind(...binds) : prepared;
    const res = await stmt.all<T>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

/** reviewed = the PRs gittensory actually reviewed (excludes ignored drafts/bots + errors). */
function reviewedOf(d: { merged: number; closed: number; commented: number; manual: number }): number {
  return d.merged + d.closed + d.commented + d.manual;
}

/** Share of reviewed PRs resolved WITHOUT a merge (closed/advised/escalated); null when nothing reviewed. */
function filteredPct(reviewed: number, merged: number): number | null {
  if (reviewed <= 0) return null;
  return Math.round(((reviewed - merged) / reviewed) * 1000) / 10;
}

/** Reversal-grounded accuracy over the irreversible auto-actions (merged + closed); null until there is signal. */
function accuracyPct(merged: number, closed: number, reversed: number): number | null {
  const decided = merged + closed;
  if (decided <= 0) return null;
  return Math.round((1 - reversed / decided) * 1000) / 10;
}

interface DispositionRow {
  project: string;
  handled: number;
  merged: number;
  closed: number;
  commented: number;
  ignored: number;
  manual: number;
  error: number;
}

/** Post-freeze live delta per project, derived from audit_events (the live ledger). One distinct PR per row
 *  per kind; reviewed/commented = pr_public_surface_published, merged = live agent.action.merge, closed =
 *  live agent.action.close. project == repoFullName == the target_key prefix before '#'. */
interface LiveDeltaRow {
  project: string;
  reviewed: number;
  merged: number;
  closed: number;
}

/** Add the live audit_events overlay onto the frozen review_targets base, de-duped by PR. The overlay only
 *  counts events strictly AFTER `frozenIso` (the snapshot freeze point) and only PRs whose target_key is NOT
 *  already present in review_targets, so historical PRs are never double-counted. A merge/close is counted
 *  only for the live agent path (metadata_json.mode = 'live'); dry-runs (which also record outcome
 *  'completed') are excluded. SQLite: instr(target_key,'#') splits `${repoFullName}#${number}` back to the
 *  project (== repoFullName). */
const LIVE_DELTA_SQL = `
  WITH frozen AS (
    SELECT DISTINCT project || '#' || number AS tkey FROM review_targets
  ),
  live AS (
    SELECT
      substr(target_key, 1, instr(target_key, '#') - 1) AS project,
      target_key AS tkey,
      MAX(CASE WHEN event_type = 'github_app.pr_public_surface_published' AND outcome = 'completed' THEN 1 ELSE 0 END) AS reviewed,
      MAX(CASE WHEN event_type = 'agent.action.merge' AND outcome = 'completed' AND json_extract(metadata_json, '$.mode') = 'live' THEN 1 ELSE 0 END) AS merged,
      MAX(CASE WHEN event_type = 'agent.action.close' AND outcome = 'completed' AND json_extract(metadata_json, '$.mode') = 'live' THEN 1 ELSE 0 END) AS closed
    FROM audit_events
    WHERE created_at > ?
      AND instr(target_key, '#') > 0
      AND event_type IN ('github_app.pr_public_surface_published', 'agent.action.merge', 'agent.action.close')
    GROUP BY target_key
  )
  SELECT project,
         SUM(reviewed) AS reviewed,
         SUM(merged) AS merged,
         SUM(closed) AS closed
  FROM live
  WHERE tkey NOT IN (SELECT tkey FROM frozen)
  GROUP BY project`;

export interface PublicStatsPayload {
  generatedAt: string;
  updatedAt: string;
  totals: {
    handled: number;
    reviewed: number;
    merged: number;
    closed: number;
    commented: number;
    ignored: number;
    manual: number;
    error: number;
    reversed: number;
    filteredPct: number | null;
    accuracyPct: number | null;
    minutesSaved: number;
  };
  /** Trailing-7-day additions (by review time), for the "+N this week" hero delta. */
  weekly: { reviewed: number; merged: number };
  /** Per-repo split, busiest first. Public repo slugs only. */
  byProject: Array<{ project: string; reviewed: number; merged: number; closed: number; accuracyPct: number | null }>;
}

const DISPOSITION_SELECT = `
  SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END) AS merged,
  SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN status = 'commented' THEN 1 ELSE 0 END) AS commented,
  SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored,
  SUM(CASE WHEN status = 'manual' THEN 1 ELSE 0 END) AS manual,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error`;

/** Assemble the public-safe payload from the frozen review_targets snapshot UNION the live audit_events overlay. */
export async function getPublicStats(env: Env, nowMs: number = Date.now()): Promise<PublicStatsPayload> {
  const sinceIso = new Date(nowMs - 7 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  // The snapshot freeze point: review_targets stopped advancing at the agent cutover. We overlay only the
  // audit_events strictly newer than this so the homepage counters keep moving without double-counting history.
  const frozenRows = await safeAll<{ frozenAt: string | null }>(env, `SELECT MAX(created_at) AS frozenAt FROM review_targets`);
  const frozenIso = frozenRows[0]?.frozenAt ?? "0";
  const [dispositions, reversalRows, weekly, liveDeltas, weeklyLive] = await Promise.all([
    safeAll<DispositionRow>(env, `SELECT project, COUNT(*) AS handled,${DISPOSITION_SELECT} FROM review_targets GROUP BY project`),
    safeAll<{ project: string; reversed: number }>(
      env,
      `SELECT project, COUNT(*) AS reversed FROM review_audit
       WHERE event_type IN ('reversal_reverted', 'reversal_reopened') GROUP BY project`,
    ),
    safeAll<{ merged: number; closed: number; commented: number; manual: number }>(
      env,
      `SELECT${DISPOSITION_SELECT.replace(/, $/, "")} FROM review_targets WHERE created_at >= ?`,
      sinceIso,
    ),
    safeAll<LiveDeltaRow>(env, LIVE_DELTA_SQL, frozenIso),
    safeAll<LiveDeltaRow>(env, LIVE_DELTA_SQL.replace("created_at > ?", "created_at > ? AND created_at >= ?"), frozenIso, new Date(nowMs - 7 * 86_400_000).toISOString()),
  ]);

  // Fold the live overlay into the frozen disposition base, keyed by project (== repoFullName). A live review
  // adds to `commented` (reviewed-but-not-yet-auto-actioned); a live merge/close adds to `merged`/`closed`.
  const dispoByProject = new Map<string, DispositionRow>(dispositions.map((d) => [d.project, { ...d }]));
  for (const delta of liveDeltas) {
    const base = dispoByProject.get(delta.project) ?? { project: delta.project, handled: 0, merged: 0, closed: 0, commented: 0, ignored: 0, manual: 0, error: 0 };
    const dMerged = delta.merged ?? 0;
    const dClosed = delta.closed ?? 0;
    // A reviewed PR that was neither merged nor closed by the agent counts as commented (reviewed + advised).
    const dCommented = Math.max((delta.reviewed ?? 0) - dMerged - dClosed, 0);
    base.handled = (base.handled ?? 0) + dMerged + dClosed + dCommented;
    base.merged = (base.merged ?? 0) + dMerged;
    base.closed = (base.closed ?? 0) + dClosed;
    base.commented = (base.commented ?? 0) + dCommented;
    dispoByProject.set(delta.project, base);
  }
  const mergedDispositions = [...dispoByProject.values()];

  const reversedByProject = new Map(reversalRows.map((r) => [r.project, r.reversed ?? 0]));
  const totals = { handled: 0, merged: 0, closed: 0, commented: 0, ignored: 0, manual: 0, error: 0, reversed: 0 };
  const byProject = mergedDispositions
    .map((d) => {
      const merged = d.merged ?? 0;
      const closed = d.closed ?? 0;
      const commented = d.commented ?? 0;
      const manual = d.manual ?? 0;
      const ignored = d.ignored ?? 0;
      const error = d.error ?? 0;
      const reversed = reversedByProject.get(d.project) ?? 0;
      totals.handled += d.handled ?? 0;
      totals.merged += merged;
      totals.closed += closed;
      totals.commented += commented;
      totals.ignored += ignored;
      totals.manual += manual;
      totals.error += error;
      totals.reversed += reversed;
      const reviewed = reviewedOf({ merged, closed, commented, manual });
      return { project: d.project, reviewed, merged, closed, accuracyPct: accuracyPct(merged, closed, reversed) };
    })
    .filter((r) => r.reviewed > 0)
    .sort((a, b) => b.reviewed - a.reviewed);

  const reviewed = reviewedOf(totals);
  // Weekly hero delta: frozen trailing-7d rows (if any remain in-window post-freeze) PLUS the live trailing-7d
  // overlay, so '+N this week' reflects what the agent has actually done since the cutover.
  const wBase = weekly[0] ?? { merged: 0, closed: 0, commented: 0, manual: 0 };
  const wLive = weeklyLive.reduce((acc, r) => ({ reviewed: acc.reviewed + (r.reviewed ?? 0), merged: acc.merged + (r.merged ?? 0) }), { reviewed: 0, merged: 0 });
  const w = { merged: (wBase.merged ?? 0) + wLive.merged, closed: wBase.closed ?? 0, commented: wBase.commented ?? 0, manual: wBase.manual ?? 0 };
  const generatedAt = new Date(nowMs).toISOString();
  return {
    generatedAt,
    updatedAt: generatedAt,
    totals: {
      ...totals,
      reviewed,
      filteredPct: filteredPct(reviewed, totals.merged),
      accuracyPct: accuracyPct(totals.merged, totals.closed, totals.reversed),
      minutesSaved: reviewed * MINUTES_SAVED_PER_PR,
    },
    weekly: { reviewed: reviewedOf(w) + wLive.reviewed, merged: w.merged ?? 0 },
    byProject,
  };
}

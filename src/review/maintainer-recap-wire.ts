// Maintainer recap digest scheduling (#1963, #2248; flag GITTENSORY_MAINTAINER_RECAP). The cron-driven trigger
// for the CROSS-repo RecapReport digest (buildMaintainerRecap, #2239) -- distinct from generate-review-recap's
// single-repo ReviewRecap job, which is manually-triggerable only (review-recap.ts). Flag-gated and OFF by
// default, mirroring isOpsEnabled: flag-OFF, the cron enqueues no job and this module's exports are never
// invoked, so the deploy is byte-identical to today.
import { listRepositories } from "../db/repositories";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { loadGatePrecisionReport } from "../services/gate-precision";
import { buildRepoOutcomeCalibration } from "../services/outcome-calibration";
import { buildMaintainerRecap, type MaintainerRecapRepoInput } from "../services/maintainer-recap";
import { deliverRecapToDiscord } from "../services/notify-discord";
import { errorMessage, nowIso } from "../utils/json";
import type { RecapReport } from "../types";

/** True when the cross-repo maintainer recap digest is enabled. Flag-OFF (default) -- the cron enqueues no job
 *  and runMaintainerRecapJob is never invoked. Truthy follows the codebase convention (same as isOpsEnabled). */
export function isRecapEnabled(env: { GITTENSORY_MAINTAINER_RECAP?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_MAINTAINER_RECAP ?? "");
}

export type RecapCadence = "daily" | "weekly";

const DEFAULT_RECAP_CADENCE: RecapCadence = "weekly";
/** 14:00 UTC -- distinct from the weekly-value-report's Monday-12:00 slot so the two digests never collide. */
const DEFAULT_RECAP_HOUR = 14;
/** Monday (UTC) -- same day the weekly-value-report's operator digest already uses. */
const DEFAULT_RECAP_DAY_OF_WEEK = 1;
const MIN_HOUR = 0;
const MAX_HOUR = 23;
const MIN_DAY_OF_WEEK = 0;
const MAX_DAY_OF_WEEK = 6;
const DEFAULT_RECAP_WINDOW_DAYS = 7;

function normalizeRecapCadence(value: string | undefined): RecapCadence {
  return value === "daily" || value === "weekly" ? value : DEFAULT_RECAP_CADENCE;
}

function normalizeRecapHour(value: string | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RECAP_HOUR;
  return Math.max(MIN_HOUR, Math.min(MAX_HOUR, Math.round(numeric)));
}

function normalizeRecapDayOfWeek(value: string | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RECAP_DAY_OF_WEEK;
  return Math.max(MIN_DAY_OF_WEEK, Math.min(MAX_DAY_OF_WEEK, Math.round(numeric)));
}

/**
 * True on the one cron tick per period the maintainer recap should fire: "daily" fires every day at the
 * configured hour; "weekly" fires ONLY on the configured day-of-week at that hour, so the tick fires at most
 * once per period. Caller passes the SAME `hour` / `dayOfWeek` enqueueScheduledJobs already derived from
 * `scheduledAt` (src/index.ts) -- no new Date parsing here. An invalid GITTENSORY_RECAP_CADENCE value falls
 * back to the "weekly" default rather than silently firing daily, so a typo'd env var can't quietly spam the
 * digest more often than intended.
 */
export function shouldFireMaintainerRecap(
  env: {
    GITTENSORY_RECAP_CADENCE?: string | undefined;
    GITTENSORY_RECAP_HOUR?: string | undefined;
    GITTENSORY_RECAP_DAY?: string | undefined;
  },
  hour: number,
  dayOfWeek: number,
): boolean {
  if (hour !== normalizeRecapHour(env.GITTENSORY_RECAP_HOUR)) return false;
  const cadence = normalizeRecapCadence(env.GITTENSORY_RECAP_CADENCE);
  return cadence === "daily" || dayOfWeek === normalizeRecapDayOfWeek(env.GITTENSORY_RECAP_DAY);
}

/** The repos this recap scans. Mirrors ops-wire.ts's opsScanRepos / pr-reconciliation.ts's watchedRepos: prefer
 *  agent-configured repos when any opted in (the acting-autonomy surface), else fall back to every registered
 *  repo so the digest still reports before the agent is enabled anywhere. */
async function recapScanRepos(env: Env): Promise<string[]> {
  const repos = (await listRepositories(env)).filter((repo) => repo.isRegistered);
  const configured: string[] = [];
  for (const repo of repos) {
    try {
      const settings = await resolveRepositorySettings(env, repo.fullName);
      if (isAgentConfigured(settings.autonomy)) configured.push(repo.fullName);
    } catch {
      /* a settings blip on one repo must not abort the whole scan */
    }
  }
  return configured.length > 0 ? configured : repos.map((repo) => repo.fullName);
}

/**
 * Build the cross-repo RecapReport (#2239) over the recap's scan repos and deliver it to Discord. A per-repo
 * aggregator failure is logged and that repo is skipped -- one repo's D1 hiccup must not blank the whole
 * digest (mirrors ops-wire.ts's runOpsAlerts). deliverRecapToDiscord itself never throws (best-effort webhook).
 */
export async function runMaintainerRecapJob(
  env: Env,
  windowDays?: number,
): Promise<{ report: RecapReport; delivery: { sent: boolean; reason?: string } }> {
  const resolvedWindowDays = windowDays ?? DEFAULT_RECAP_WINDOW_DAYS;
  const repoNames = await recapScanRepos(env);
  const repos: MaintainerRecapRepoInput[] = [];
  for (const repoFullName of repoNames) {
    try {
      const [gatePrecision, calibration] = await Promise.all([
        loadGatePrecisionReport(env, repoFullName, { windowDays: resolvedWindowDays }),
        buildRepoOutcomeCalibration(env, repoFullName, resolvedWindowDays),
      ]);
      repos.push({ gatePrecision, calibration });
    } catch (error) {
      console.warn(
        JSON.stringify({ event: "maintainer_recap_repo_error", repo: repoFullName, message: errorMessage(error).slice(0, 200) }),
      );
    }
  }
  const report = buildMaintainerRecap({ generatedAt: nowIso(), windowDays: resolvedWindowDays, repos });
  const delivery = await deliverRecapToDiscord(env, report);
  return { report, delivery };
}

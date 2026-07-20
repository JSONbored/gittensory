// Flag guard for the contributor trust-profile / fairness-analytics internal surface (#fairness-analytics).
// Off by default (truthy-string env flag, matching isPublicStatsEnabled/isParityAuditEnabled's own convention)
// so the internal routes 404 and the deploy is byte-identical until an operator deliberately turns this on.
//
// TWO SEPARATE config-as-code axes, matching the moderation-rules engine's own split:
//   - THIS gate (env var + the self-repo's fleet-wide `fairnessAnalytics:` manifest block) controls whether
//     the internal routes exist at all.
//   - Per-repo DATA PARTICIPATION (`RepositorySettings.fairnessAnalyticsMode`, resolved per project via each
//     installed repo's OWN private `.loopover.yml` `settings:` block) controls whether a given repo's rows are
//     included when computing fleet-wide analytics -- see resolveFairnessAnalyticsParticipation below and its
//     use in contributor-gate-eval.ts / contributor-trust-profile.ts.
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { errorMessage } from "../utils/json";

/** Mirrors public-stats.ts's PublicStatsManifestOverride exactly. `present: false` means "no override
 *  configured" (fall through to the env var), not "disabled". */
export type FairnessAnalyticsManifestOverride = { present: boolean; enabled: boolean };

export function isFairnessAnalyticsEnabled(
  env: { LOOPOVER_FAIRNESS_ANALYTICS?: string | undefined },
  manifestOverride?: FairnessAnalyticsManifestOverride | undefined,
): boolean {
  if (manifestOverride?.present) return manifestOverride.enabled;
  return /^(1|true|yes|on)$/i.test(env.LOOPOVER_FAIRNESS_ANALYTICS ?? "");
}

// Mirrors public-stats.ts's own 60s TTL cache for the identical reason: these internal routes are
// bearer-gated (not a hot public path), but the manifest lookup still shouldn't re-hit D1/GitHub on every call.
const FAIRNESS_ANALYTICS_MANIFEST_OVERRIDE_CACHE_TTL_MS = 60_000;
let fairnessAnalyticsManifestOverrideCache: { override: FairnessAnalyticsManifestOverride; at: number } | null = null;

/** Config-as-code override lookup (#fairness-analytics): read the `fairnessAnalytics` block off the loopover
 *  self-repo's `.loopover.yml`. Mirrors resolvePublicStatsManifestOverride (public-stats.ts) exactly, including
 *  its fail-safe-to-{present:false} degrade on a manifest load error. */
export async function resolveFairnessAnalyticsManifestOverride(env: Env, nowMs: number = Date.now()): Promise<FairnessAnalyticsManifestOverride> {
  const hit = fairnessAnalyticsManifestOverrideCache;
  if (hit && nowMs - hit.at < FAIRNESS_ANALYTICS_MANIFEST_OVERRIDE_CACHE_TTL_MS) return hit.override;
  try {
    const manifest = await loadRepoFocusManifest(env, resolveLoopOverSelfRepoFullName(env));
    const config = manifest.fairnessAnalytics;
    const override = { present: config.present, enabled: config.enabled };
    fairnessAnalyticsManifestOverrideCache = { override, at: nowMs };
    return override;
  } catch (error) {
    console.warn(JSON.stringify({ event: "fairness_analytics_manifest_override_error", message: errorMessage(error).slice(0, 200) }));
    const override = { present: false, enabled: false };
    fairnessAnalyticsManifestOverrideCache = { override, at: nowMs };
    return override;
  }
}

/** Test-only: clears the cached override, mirroring clearPublicStatsManifestOverrideCacheForTest. */
export function clearFairnessAnalyticsManifestOverrideCacheForTest(): void {
  fairnessAnalyticsManifestOverrideCache = null;
}

/** Per-repo participation resolver (#fairness-analytics): "off" excludes this repo's rows from every
 *  fleet-wide aggregation; "inherit"/"enabled" (or unset, e.g. an unregistered/unconfigured repo) participate.
 *  Pure -- callers resolve `RepositorySettings.fairnessAnalyticsMode` (via resolveRepositorySettings, which
 *  already overlays the repo's own `.loopover.yml` on the DB default) and pass it in. */
export function resolveFairnessAnalyticsParticipation(mode: "inherit" | "off" | "enabled" | undefined): boolean {
  return mode !== "off";
}

/** Resolves each distinct project's `fairnessAnalyticsMode` (DB default overlaid by that repo's OWN
 *  `.loopover.yml`, via resolveRepositorySettings) and returns the subset still eligible to participate.
 *  Fail-safe per project: a settings-resolution error defaults that ONE project to eligible (matching
 *  resolveRepositorySettings' own fail-open DB-default behavior) rather than dropping it or failing the whole
 *  batch over one bad repo. */
export async function resolveEligibleFairnessAnalyticsProjects(env: Env, projects: readonly string[]): Promise<Set<string>> {
  const distinct = [...new Set(projects)];
  const results = await Promise.all(
    distinct.map(async (project) => {
      try {
        const settings = await resolveRepositorySettings(env, project);
        return { project, eligible: resolveFairnessAnalyticsParticipation(settings.fairnessAnalyticsMode) };
      } catch {
        return { project, eligible: true };
      }
    }),
  );
  return new Set(results.filter((r) => r.eligible).map((r) => r.project));
}

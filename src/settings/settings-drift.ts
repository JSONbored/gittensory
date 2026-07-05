import { getGlobalContributorBlacklist, getRepositorySettings } from "../db/repositories";
import { parseFocusManifest, resolveEffectiveSettings, type FocusManifest } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import type { RepositorySettings } from "../types";

// The "no manifest at all" baseline (parseFocusManifest(null) is this codebase's existing idiom for it, e.g.
// test/unit/focus-manifest.test.ts). Comparing against THIS instead of the raw dbSettings row isolates drift
// caused specifically by the manifest -- resolveEffectiveSettings also applies manifest-INDEPENDENT
// normalization (the shared contributor-blacklist merge below the gate block, and the requireLinkedIssue-implies-
// block downgrade), which would otherwise misreport as "shadowed by private config" for every repo with a
// global blacklist entry, even one with no manifest at all.
const NO_MANIFEST = parseFocusManifest(null);

export type SettingsDriftEntry = {
  field: keyof RepositorySettings;
  dbValue: unknown;
  effectiveValue: unknown;
};

// Local copy of the stableStringify helper already duplicated in review/ai-review-cache-input.ts and
// upstream/ruleset.ts for the same order-independent-equality purpose -- matches this codebase's existing
// pattern of a small per-module copy rather than a shared utility for a ~6-line function.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Diagnostic-only, read-only diff between a repo's DB-stored `repository_settings` row and the LIVE effective
 * settings `resolveEffectiveSettings` would actually apply for it (config-as-code `.gittensory.yml` merged over
 * the DB row). Every entry here is a DB-stored field whose value is silently shadowed by a manifest override --
 * useful for a self-host operator who changed something via the dashboard and can't tell why it isn't taking
 * effect. PURE and never called from the live review/gate path itself (see resolveEffectiveSettings,
 * settings/repository-settings.ts's resolveRepositorySettings) -- this can never affect what settings a PR
 * review actually resolves to, only report on it after the fact.
 */
export function computeSettingsDrift(
  dbSettings: RepositorySettings,
  manifest: FocusManifest,
  sharedContributorBlacklist: RepositorySettings["contributorBlacklist"] = [],
): SettingsDriftEntry[] {
  const baseline = resolveEffectiveSettings(dbSettings, NO_MANIFEST, sharedContributorBlacklist);
  const effective = resolveEffectiveSettings(dbSettings, manifest, sharedContributorBlacklist);
  return (Object.keys(dbSettings) as (keyof RepositorySettings)[])
    .filter((field) => stableStringify(baseline[field]) !== stableStringify(effective[field]))
    .map((field) => ({ field, dbValue: dbSettings[field], effectiveValue: effective[field] }));
}

/** Same diff, but fetching the DB row, manifest, and shared contributor blacklist live for one repo -- the
 *  same three reads settings/repository-settings.ts's resolveRepositorySettings already makes, so this never
 *  introduces a new data-fetch path, only a read-only diagnostic view over the existing one. */
export async function computeSettingsDriftForRepo(env: Env, repoFullName: string): Promise<SettingsDriftEntry[]> {
  const [dbSettings, manifest, sharedContributorBlacklist] = await Promise.all([
    getRepositorySettings(env, repoFullName),
    loadRepoFocusManifest(env, repoFullName),
    getGlobalContributorBlacklist(env).catch(() => []),
  ]);
  return computeSettingsDrift(dbSettings, manifest, sharedContributorBlacklist);
}

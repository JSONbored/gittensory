import { extractContributionProfile } from "./contribution-profile-extract.js";
import { fetchRepoLabelDescriptions, profileNeedsLabelDescriptions } from "./contribution-profile-eligibility.js";

// Per-repo ContributionProfile resolution for `discover` (#6798): reads a fresh profile from the cache (#6797)
// when one exists and is not stale, otherwise extracts (#6796) live and writes the result back. A caller with no
// cache (dry-run, matching the existing policyDocCache/policyVerdictCache convention of never opening a
// not-yet-existing store during a dry run) always extracts live -- same "read-only GETs are fine, but no local
// store writes" rule discover-cli.js already applies to the other two caches.

/**
 * Resolve one repo's profile: cache hit (fresh) wins; otherwise extract live and best-effort write the result
 * back to the cache. A cache write failure is non-fatal (the profile itself is still returned) -- the cache is a
 * pure performance optimization, never a requirement for discover to have a profile to filter with.
 */
async function resolveOneProfile(repoFullName, options) {
  if (options.cache) {
    const cached = options.cache.get(repoFullName, options.nowMs);
    if (cached && !cached.stale) return cached.profile;
  }
  const profile = await extractContributionProfile(repoFullName, {
    fetchImpl: options.fetchImpl,
    githubToken: options.githubToken,
    apiBaseUrl: options.apiBaseUrl,
    generatedAt: options.generatedAt,
  });
  if (options.cache) {
    try {
      options.cache.put(profile, options.nowMs);
    } catch {
      // Non-fatal: a corrupt/unwritable cache must never block discover from using the profile it just extracted.
    }
  }
  return profile;
}

/**
 * Resolve every distinct repo's ContributionProfile (and, only where the profile actually needs it, its full
 * label list for description-field matching) in parallel.
 *
 * @param {string[]} repoFullNames
 * @param {{
 *   cache?: import("./contribution-profile-cache.js").ContributionProfileCache | null,
 *   fetchImpl?: typeof fetch,
 *   githubToken?: string,
 *   apiBaseUrl?: string,
 *   nowMs?: number,
 *   generatedAt?: string,
 * }} [options]
 * @returns {Promise<{
 *   profilesByRepo: Map<string, import("./contribution-profile.js").ContributionProfile>,
 *   labelDescriptionsByRepo: Map<string, Map<string, string | null>>,
 * }>}
 */
export async function resolveContributionProfiles(repoFullNames, options = {}) {
  const profilesByRepo = new Map();
  const labelDescriptionsByRepo = new Map();

  await Promise.all(
    repoFullNames.map(async (repoFullName) => {
      const profile = await resolveOneProfile(repoFullName, options);
      profilesByRepo.set(repoFullName, profile);
      if (profileNeedsLabelDescriptions(profile)) {
        const descriptions = await fetchRepoLabelDescriptions(repoFullName, {
          fetchImpl: options.fetchImpl,
          githubToken: options.githubToken,
          apiBaseUrl: options.apiBaseUrl,
        });
        labelDescriptionsByRepo.set(repoFullName, descriptions);
      }
    }),
  );

  return { profilesByRepo, labelDescriptionsByRepo };
}

import type { ContributionProfile } from "./contribution-profile.js";
import type { ContributionProfileCache } from "./contribution-profile-cache.js";

export type ResolveContributionProfilesResult = {
  profilesByRepo: Map<string, ContributionProfile>;
  labelDescriptionsByRepo: Map<string, Map<string, string | null>>;
};

/** The read/write surface this module actually needs to inject a cache without depending on the SQLite store
 *  (`dbPath`/`close` are lifecycle concerns the caller, not the resolver, owns) -- mirrors the narrower
 *  `PolicyDocCache`/`PolicyVerdictCache` convenience types those sibling caches export; contribution-profile-
 *  cache.js doesn't export an equivalent narrowed type itself, so it's defined locally here instead. */
export type ContributionProfileCacheReader = Pick<ContributionProfileCache, "get" | "put">;

export function resolveContributionProfiles(
  repoFullNames: string[],
  options?: {
    cache?: ContributionProfileCacheReader | null;
    fetchImpl?: typeof fetch;
    githubToken?: string;
    apiBaseUrl?: string;
    nowMs?: number;
    generatedAt?: string;
  },
): Promise<ResolveContributionProfilesResult>;

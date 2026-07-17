import type {
  CachedContributionProfile,
  ContributionProfile,
} from "./contribution-profile.js";

export type ContributionProfileCache = {
  dbPath: string;
  /** Read a cached profile, or null when absent or unparseable. `stale` is true past the TTL. */
  get(repoFullName: string, nowMs?: number): CachedContributionProfile | null;
  /** Cache a profile keyed by its own repoFullName, stamped with `nowMs` (defaults to now). */
  put(
    profile: ContributionProfile,
    nowMs?: number,
  ): { repoFullName: string; fetchedAt: string };
  close(): void;
};

export function resolveContributionProfileCacheDbPath(
  env?: Record<string, string | undefined>,
): string;

export function initContributionProfileCache(
  dbPath?: string,
): ContributionProfileCache;

export function getCachedContributionProfile(
  repoFullName: string,
  nowMs?: number,
): CachedContributionProfile | null;

export function putCachedContributionProfile(
  profile: ContributionProfile,
  nowMs?: number,
): { repoFullName: string; fetchedAt: string };

export function closeDefaultContributionProfileCache(): void;

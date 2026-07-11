// Brokered self-host installed-repo sync (#5028, part of the isRegistered/isInstalled untangling epic #5016). A
// brokered self-host learns its own repo list from GitHub directly, via its broker token -- the same list a
// non-brokered self-host or cloud installation already gets eagerly through real `installation`/
// `installation_repositories` webhooks. The central Orb relay deliberately does NOT forward those two events to
// brokered containers (src/orb/relay.ts's RELAY_FORWARD_EVENTS -- the container runs under the CENTRAL Orb App,
// not its own, so it must not treat those as its own installation state). Without this sync, a brokered
// self-host only learns about a repo the FIRST time a forwarded PR/issue event arrives for it: a freshly
// enrolled, quiet repo has no local `repositories` row at all, and every core feature gated on `isInstalled`
// silently skips it.

import { listInstalledRepoFullNamesForInstallation, markRepositoriesRemovedFromInstallation, upsertRepositoryFromGitHub } from "../db/repositories";
import { githubHeaders } from "../github/client";
import type { GitHubRepositoryPayload } from "../types";
import { fetchBrokeredInstallationToken, isOrbBrokerMode } from "./broker-client";

const GITHUB_INSTALLATION_REPOS_PAGE_SIZE = 100;
// Bounds worst-case pagination for a single sync tick. A real maintainer's installation has a handful of repos;
// this caps runaway pagination against a misbehaving response to a sane worst case (5,000 repos) rather than
// looping unbounded.
const MAX_INSTALLATION_REPOS_PAGES = 50;

export type InstalledReposSyncResult =
  | { status: "skipped" }
  | { status: "synced"; installationId: number; repoCount: number; removedCount: number }
  | { status: "failed"; reason: string };

/** Fetch every repo currently accessible to this brokered installation via GitHub's own
 *  `GET /installation/repositories`, paginated. Uses the broker token directly -- its response already carries
 *  the bound installationId, so no separate token mint is needed for this call. */
async function fetchAllInstallationRepos(token: string, fetchImpl: typeof fetch): Promise<GitHubRepositoryPayload[]> {
  const repos: GitHubRepositoryPayload[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_REPOS_PAGES; page += 1) {
    const res = await fetchImpl(`https://api.github.com/installation/repositories?per_page=${GITHUB_INSTALLATION_REPOS_PAGE_SIZE}&page=${page}`, {
      headers: githubHeaders({ token }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`installation_repositories_http_${res.status}`);
    const body = (await res.json()) as { repositories?: GitHubRepositoryPayload[] };
    const batch = body.repositories ?? [];
    repos.push(...batch);
    if (batch.length < GITHUB_INSTALLATION_REPOS_PAGE_SIZE) break;
  }
  return repos;
}

/**
 * Sync this brokered self-host's `repositories.isInstalled` rows against GitHub's live installation-repos list:
 * every returned repo is upserted with `isInstalled: true` (mirrors what the webhook handler already does on
 * every forwarded event); every LOCAL repo previously marked installed under this installationId that is no
 * longer in the fresh list is flipped to `isInstalled: false` (a repo removed from the installation, or moved
 * out of a "selected" install's scope).
 *
 * No-op (`status: "skipped"`) outside broker mode -- a non-brokered self-host or cloud already gets this
 * eagerly via real installation webhooks, and this must never run there (isOrbBrokerMode's signal, the
 * enrollment secret's presence, is the same guard every other broker-only self-host path uses).
 *
 * Best-effort: any failure (broker down, GitHub throttled/erroring) returns `status: "failed"` rather than
 * throwing, matching the fail-safe convention of every other cron sync in this codebase (e.g.
 * registerOrbRelayTargetWithRetry) -- a sync miss self-heals on the next scheduled tick, never blocks the cron.
 */
export async function syncBrokeredInstalledRepos(
  env: { ORB_ENROLLMENT_SECRET?: string | undefined; ORB_BROKER_URL?: string | undefined } & Env,
  fetchImpl: typeof fetch = fetch,
): Promise<InstalledReposSyncResult> {
  if (!isOrbBrokerMode(env)) return { status: "skipped" };
  try {
    const { token, installationId } = await fetchBrokeredInstallationToken(env, fetchImpl);
    const repos = await fetchAllInstallationRepos(token, fetchImpl);
    for (const repo of repos) {
      await upsertRepositoryFromGitHub(env, repo, installationId);
    }
    const freshFullNames = new Set(repos.map((repo) => repo.full_name));
    const previouslyInstalled = await listInstalledRepoFullNamesForInstallation(env, installationId);
    const staleFullNames = previouslyInstalled.filter((fullName) => !freshFullNames.has(fullName));
    await markRepositoriesRemovedFromInstallation(env, installationId, staleFullNames);
    return { status: "synced", installationId, repoCount: repos.length, removedCount: staleFullNames.length };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "sync_failed" };
  }
}

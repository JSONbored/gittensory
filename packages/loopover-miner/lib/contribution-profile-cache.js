// ContributionProfile local cache store (#6797). Persists the extraction output (#6796) keyed by repo, so a
// repeated `discover` run within the freshness window doesn't re-fetch/re-parse the same labels + docs. 100%
// local/client-side, like every other miner store: never uploads, syncs, or phones home. Follows the shared
// local-store.js pattern (openLocalStoreDb + resolveLocalStoreDbPath + the schema-version stamp) so it is
// picked up by `doctor`'s store-integrity sweep and `migrate` the same way its siblings are.
import {
  CONTRIBUTION_PROFILE_CACHE_TTL_MS,
  CONTRIBUTION_PROFILE_STORE_TABLE,
} from "./contribution-profile.js";
import {
  normalizeLocalStoreDbPath,
  openLocalStoreDb,
  resolveLocalStoreDbPath,
} from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";

const defaultDbFileName = "contribution-profile-cache.sqlite3";
let defaultContributionProfileCache = null;

export function resolveContributionProfileCacheDbPath(env = process.env) {
  return resolveLocalStoreDbPath(
    defaultDbFileName,
    "LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB",
    env,
  );
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(
    dbPath,
    resolveContributionProfileCacheDbPath(),
    "invalid_contribution_profile_cache_db_path",
  );
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string")
    throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined)
    throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

/**
 * Open the 100%-local contribution-profile cache. The DB only lives on this machine (#6797).
 *
 * @param {string} [dbPath]
 */
export function initContributionProfileCache(
  dbPath = resolveContributionProfileCacheDbPath(),
) {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTRIBUTION_PROFILE_STORE_TABLE} (
      repo_full_name TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `);
  // Schema-version convention (#4832): stamp the baseline. No post-baseline migrations for this v1 store yet.
  applySchemaMigrations(db, []);

  const getStatement = db.prepare(
    `SELECT profile_json, fetched_at FROM ${CONTRIBUTION_PROFILE_STORE_TABLE} WHERE repo_full_name = ?`,
  );
  const putStatement = db.prepare(`
    INSERT INTO ${CONTRIBUTION_PROFILE_STORE_TABLE} (repo_full_name, profile_json, fetched_at)
    VALUES (?, ?, ?)
    ON CONFLICT(repo_full_name) DO UPDATE SET
      profile_json = excluded.profile_json,
      fetched_at = excluded.fetched_at
  `);

  return {
    dbPath: resolvedPath,
    /**
     * Read a cached profile. Returns { profile, fetchedAt, stale } or null when absent. `stale` is true once
     * the row is older than the TTL, so a caller re-extracts. A row whose JSON is unparseable is treated as a
     * miss (fail closed) rather than throwing — a corrupted/hand-edited file must not break discover.
     *
     * @param {string} repoFullName
     * @param {number} [nowMs] current time in ms, injectable for deterministic tests
     */
    get(repoFullName, nowMs = Date.now()) {
      const row = getStatement.get(normalizeRepoFullName(repoFullName));
      if (!row) return null;
      let profile;
      try {
        profile = JSON.parse(row.profile_json);
      } catch {
        return null;
      }
      const fetchedMs = Date.parse(row.fetched_at);
      // An unparseable timestamp fails closed to stale, so a corrupted row is re-extracted rather than trusted.
      const stale =
        Number.isNaN(fetchedMs) ||
        nowMs - fetchedMs > CONTRIBUTION_PROFILE_CACHE_TTL_MS;
      return { profile, fetchedAt: row.fetched_at, stale };
    },
    /**
     * Cache a profile, stamping it with the current time. The profile's own repoFullName is the key.
     *
     * @param {{ repoFullName: string }} profile a ContributionProfile
     * @param {number} [nowMs] current time in ms, injectable for deterministic tests
     */
    put(profile, nowMs = Date.now()) {
      const repoFullName = normalizeRepoFullName(profile?.repoFullName);
      const fetchedAt = new Date(nowMs).toISOString();
      putStatement.run(repoFullName, JSON.stringify(profile), fetchedAt);
      return { repoFullName, fetchedAt };
    },
    close() {
      db.close();
    },
  };
}

function getDefaultContributionProfileCache() {
  defaultContributionProfileCache ??= initContributionProfileCache();
  return defaultContributionProfileCache;
}

export function getCachedContributionProfile(repoFullName, nowMs) {
  return getDefaultContributionProfileCache().get(repoFullName, nowMs);
}

export function putCachedContributionProfile(profile, nowMs) {
  return getDefaultContributionProfileCache().put(profile, nowMs);
}

export function closeDefaultContributionProfileCache() {
  if (!defaultContributionProfileCache) return;
  defaultContributionProfileCache.close();
  defaultContributionProfileCache = null;
}

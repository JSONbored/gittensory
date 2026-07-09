import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Shared path-resolution + open boilerplate for the package's local, 100% client-side SQLite stores
// (run-state.js, claim-ledger.js, portfolio-queue.js, event-ledger.js, governor-ledger.js, plan-store.js).
// Each store keeps its own `.sqlite3` file, override env var, and schema — this module only DRYs the
// identical "where does the file live" resolution and "open it safely" setup that used to be hand-copied
// in every one of them. (#4272)

/**
 * Resolves a local store's DB path: an explicit per-store override env var, else
 * `GITTENSORY_MINER_CONFIG_DIR`, else `XDG_CONFIG_HOME` (or `~/.config`) + `gittensory-miner`, joined
 * with `defaultFileName`.
 */
export function resolveLocalStoreDbPath(env, overrideEnvVar, defaultFileName) {
  const explicitPath = typeof env[overrideEnvVar] === "string" ? env[overrideEnvVar].trim() : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultFileName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", defaultFileName);
}

/**
 * Opens a local store's SQLite file: creates its parent directory (0o700), opens the `DatabaseSync`
 * handle, locks the file down to 0o600 (skipped for the special `:memory:` path, which has no file on
 * disk), and sets a 5s busy_timeout so two store instances sharing one file serialize instead of
 * throwing SQLITE_BUSY.
 */
export function openLocalStoreDb(resolvedPath) {
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(resolvedPath);
  if (resolvedPath !== ":memory:") chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

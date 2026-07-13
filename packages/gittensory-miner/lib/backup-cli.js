import { cpSync, existsSync, readdirSync } from "node:fs";
import { resolveMinerStateDir } from "./status.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

// `backup` / `restore` (#4872): a straightforward file-copy of the miner's local-state DIRECTORY (all SQLite
// stores under `GITTENSORY_MINER_CONFIG_DIR` / the XDG default), the whole directory at once — so nothing is
// missed and the set stays correct as stores are added, unlike a hand-maintained per-file list. `cpSync` copies
// the WAL/`-shm` sidecars alongside each `.sqlite3` too, so a checkpoint that hasn't folded back yet is preserved.
// Consistency caveat (surfaced in the docs + on stdout): SQLite files are safest copied while the miner is
// STOPPED; a copy taken mid-write can capture a torn page. These are read-only-of-source (backup) /
// overwrite-target (restore) file operations only — no network, no store schema access.

const BACKUP_USAGE = "Usage: gittensory-miner backup <target-dir> [--json]";
const RESTORE_USAGE = "Usage: gittensory-miner restore <source-dir> [--json]";

/** Parse a single required `<dir>` positional plus an optional `--json`. */
function parseDirArg(args, usage) {
  let json = false;
  const positional = [];
  for (const token of args) {
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }
  if (positional.length !== 1) {
    return { error: usage };
  }
  const dir = positional[0].trim();
  if (!dir) {
    return { error: usage };
  }
  return { dir, json };
}

/** `backup <target-dir>`: copy the entire local-state directory to `<target-dir>`. Refuses to overwrite an
 *  existing target (a backup should never silently clobber a previous one). Exit 2 on any failure. */
export function runBackup(args, options = {}) {
  const parsed = parseDirArg(args, BACKUP_USAGE);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }
  const env = options.env ?? process.env;
  const stateDir = resolveMinerStateDir(env);
  try {
    if (!existsSync(stateDir)) {
      return reportCliFailure(parsed.json, `no_state_directory: ${stateDir}`);
    }
    if (existsSync(parsed.dir)) {
      return reportCliFailure(parsed.json, `backup_target_exists: ${parsed.dir} (refusing to overwrite an existing directory)`);
    }
    cpSync(stateDir, parsed.dir, { recursive: true });
    const files = readdirSync(parsed.dir).sort();
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, source: stateDir, target: parsed.dir, files }, null, 2));
    } else {
      console.log(`backed up ${files.length} file(s) from ${stateDir} to ${parsed.dir} (stop the miner first for a consistent copy)`);
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

/** `restore <source-dir>`: copy a previous backup back OVER the local-state directory (overwriting existing
 *  files). The miner must be stopped first. Exit 2 on any failure. */
export function runRestore(args, options = {}) {
  const parsed = parseDirArg(args, RESTORE_USAGE);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }
  const env = options.env ?? process.env;
  const stateDir = resolveMinerStateDir(env);
  try {
    if (!existsSync(parsed.dir)) {
      return reportCliFailure(parsed.json, `no_backup_directory: ${parsed.dir}`);
    }
    cpSync(parsed.dir, stateDir, { recursive: true });
    const files = readdirSync(stateDir).sort();
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, source: parsed.dir, target: stateDir, files }, null, 2));
    } else {
      console.log(`restored ${files.length} file(s) from ${parsed.dir} to ${stateDir} (run with the miner stopped)`);
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

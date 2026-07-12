import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverMinerGoalSpecPath, parseMinerGoalSpecContent } from "@jsonbored/gittensory-engine";

const MAX_MINER_GOAL_SPEC_BYTES = 32_768;

// Real local .gittensory-miner.yml resolver (#5132, Wave 3.5 follow-up). MinerGoalSpec's own discovery
// helper (discoverMinerGoalSpecPath, packages/gittensory-engine) is deliberately IO-free -- the caller
// injects the existence check. Unlike self-review-context.js/rejection-signal.js/ams-policy.js, which fetch
// their target repo's files live over raw.githubusercontent.com BEFORE any clone exists, this resolver reads
// the ALREADY-CLONED repo on disk (attempt-worktree.js's prepareAttemptWorktree runs first in the real
// attempt-cli.js flow) -- no extra network round trip needed for a file that's already sitting in the
// worktree.

function readRegularUtf8File(path, options) {
  const lstatImpl = options.lstatSync ?? lstatSync;
  const openImpl = options.openSync ?? openSync;
  const fstatImpl = options.fstatSync ?? fstatSync;
  const readImpl = options.readFileSync ?? readFileSync;
  const closeImpl = options.closeSync ?? closeSync;

  const entry = lstatImpl(path);
  if (!entry.isFile() || entry.isSymbolicLink()) return null;

  const fd = openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatImpl(fd);
    if (!opened.isFile() || opened.size > MAX_MINER_GOAL_SPEC_BYTES) return null;
    return readImpl(fd, "utf8");
  } finally {
    closeImpl(fd);
  }
}

/**
 * Resolve the real, parsed MinerGoalSpec for an already-cloned repo at `repoPath`, trying each
 * MINER_GOAL_SPEC_FILENAMES candidate in the documented discovery order. Never throws: a missing file, an
 * unreadable file, or malformed content all degrade to the tolerant parser's own absent/safe-default result.
 *
 * Injected filesystem operations receive the FULL joined path (same convention as `node:fs`'s own
 * functions), not a repoPath-relative candidate.
 *
 * @param {string} repoPath
 * @param {{ existsSync?: (path: string) => boolean, lstatSync?: (path: string) => import("node:fs").Stats, openSync?: (path: string, flags: number) => number, fstatSync?: (fd: number) => import("node:fs").Stats, readFileSync?: (path: string | number, encoding: "utf8") => string, closeSync?: (fd: number) => void }} [options]
 * @returns {import("@jsonbored/gittensory-engine").ParsedMinerGoalSpec}
 */
export function resolveMinerGoalSpec(repoPath, options = {}) {
  const existsImpl = options.existsSync ?? existsSync;

  const relativePath = discoverMinerGoalSpecPath((candidate) => existsImpl(join(repoPath, candidate)));
  if (!relativePath) return parseMinerGoalSpecContent(null);

  try {
    const content = readRegularUtf8File(join(repoPath, relativePath), options);
    return parseMinerGoalSpecContent(content);
  } catch {
    return parseMinerGoalSpecContent(null);
  }
}

import { join } from "node:path";
import { removeWorktree } from "@loopover/engine";
import { openLocalStoreDb, resolveLocalStoreDbPath, normalizeLocalStoreDbPath } from "./local-store.js";
// Freeze/snapshot mechanism for historical replay targets (#3010). Given a repo and a commit SHA T, exports:
//  (a) the full working tree checked out AT T via a DETACHED git worktree -- the same isolation primitive
//      worktree-allocator.ts (#4269) uses for attempt isolation, just detached rather than on a new branch,
//      since a replay target is read-only, never a place to commit -- so it never mutates the caller's own
//      checkout/branch.
//  (b) a context bundle: commit history up to and including T (by ANCESTRY, via `git log T` -- walking the DAG
//      is the tamper-resistant way to bound "up to T", since a commit's committer date is user-controlled and
//      can't be trusted alone), tags reachable from T (`git tag --merged T`), and the README as it existed at
//      T (`git ls-tree` + `git show T:<name>`, matched case-insensitively rather than a guessed filename list).
//
// REUSE NOTE: this issue's own text frames "the discover and analyze phases... already read git history" as
// the reuse starting point. Grepped both packages (git log/git tag/commits/tags/releases) before writing this
// and found no such utility anywhere -- opportunity-fanout.js reads GitHub API issue `updated_at`, not git
// commit/tag history at all. The one genuinely reusable piece is worktree-allocator.ts's injected-exec
// convention (WorktreeExecFn) and its removeWorktree -- both reused directly below (import from
// @loopover/engine), rather than inventing a THIRD "inject the git subprocess" abstraction
// alongside cli-subprocess-driver.ts's and worktree-allocator.ts's own.
//
// FAIL-FAST VALIDATION: ancestry-walking (git log T) already excludes anything NOT reachable from T by
// construction, but a tag can point at a commit that IS an ancestor of T while the TAG's own creation/tagger
// date is LATER (e.g. a tag added long after the commit it points to), and commit committer-dates are not
// strictly monotonic along the DAG in general (rebases, clock skew). So checking every exported commit's date
// and every exported tag's date against T's own commit date is a genuine, not merely defensive, check.
//
// PERSISTENCE: the context bundle is cached in the local store, UNIQUE-keyed on (repo_full_name, commit_sha) --
// re-exporting the same (repo, T) pair returns the identical cached row rather than re-running git, which is
// both how "byte-reproducible" holds trivially and avoids redundant work on repeat replay runs. The working-
// tree export itself is git-content-addressed already (the same commit SHA always checks out identical files).
const defaultDbFileName = "replay-snapshot.sqlite3";
let defaultDb = null;
export function resolveReplaySnapshotDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_REPLAY_SNAPSHOT_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveReplaySnapshotDbPath(), "invalid_replay_snapshot_db_path");
}
const FIELD_SEP = "\x1f";
const README_NAME_PATTERN = /^readme(\.\w+)?$/i;
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function normalizeCommitSha(commitSha) {
    if (typeof commitSha !== "string" || !commitSha.trim())
        throw new Error("invalid_commit_sha");
    return commitSha.trim();
}
/** Worktree exports live under this dir inside the repo, mirroring worktree-allocator.ts's WORKTREE_SUBDIR. */
export const REPLAY_SNAPSHOT_SUBDIR = ".loopover-replay-snapshots";
/** PURE: the deterministic on-disk location for a (repo, commit) replay export -- same pair -> same path. */
export function planReplaySnapshotPath(input) {
    const commitSha = normalizeCommitSha(input.commitSha);
    return join(input.repoPath, REPLAY_SNAPSHOT_SUBDIR, commitSha);
}
function assertExecResult(result, description) {
    if (result.code !== 0) {
        const detail = (result.stderr ?? "").trim() || `exit_${result.code}`;
        throw new Error(`${description}: ${detail}`);
    }
    return result.stdout ?? "";
}
/** Detached checkout at commitSha via `git worktree add --detach` -- never creates a branch, never touches the
 *  caller's own checkout. Idempotent in effect: `git worktree add` itself fails if the path already has a
 *  worktree, which callers avoid by checking the store cache first (see exportReplaySnapshot). */
async function addDetachedWorktree(exec, repoPath, worktreePath, commitSha) {
    const result = await exec("git", ["worktree", "add", "--detach", worktreePath, commitSha], { cwd: repoPath });
    assertExecResult(result, "git_worktree_add_failed");
}
async function readTargetCommitDate(exec, repoPath, commitSha) {
    const result = await exec("git", ["log", "-1", "--format=%cI", commitSha], { cwd: repoPath });
    const stdout = assertExecResult(result, "git_log_target_failed").trim();
    if (!stdout)
        throw new Error(`git_log_target_failed: no commit found for ${commitSha}`);
    return stdout;
}
async function readCommitHistory(exec, repoPath, commitSha) {
    const result = await exec("git", ["log", commitSha, `--format=%H${FIELD_SEP}%cI${FIELD_SEP}%s`], { cwd: repoPath });
    const stdout = assertExecResult(result, "git_log_history_failed");
    return stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
        const [sha, date, subject] = line.split(FIELD_SEP);
        return { sha: sha, date: date, subject: subject ?? "" };
    });
}
// Lightweight tags have no tag object of their own, so `%(creatordate)` falls back to the POINTED-TO commit's
// date rather than a genuine tag-creation date -- git has no record of when a lightweight tag was actually
// created at all. That means a lightweight tag added long after T, but pointing at an ancestor of T, would
// silently pass validateSnapshotFreshness's date check every time (its reported "date" is always <= T's, by
// construction of --merged). Since this can never be verified, lightweight tags are excluded from the export
// entirely -- `%(objecttype)` is "tag" only for an annotated tag's own tag object, "commit" for a lightweight
// tag's direct target, which is how the two are told apart.
async function readReachableTags(exec, repoPath, commitSha) {
    const result = await exec("git", ["tag", "--merged", commitSha, `--format=%(refname:short)${FIELD_SEP}%(creatordate:iso-strict)${FIELD_SEP}%(objectname)${FIELD_SEP}%(objecttype)`], { cwd: repoPath });
    const stdout = assertExecResult(result, "git_tag_merged_failed");
    return stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
        const [name, date, targetSha, objectType] = line.split(FIELD_SEP);
        return { name: name, date: date, targetSha: targetSha, objectType: objectType };
    })
        .filter((tag) => tag.objectType === "tag")
        .map(({ objectType: _objectType, ...tag }) => tag);
}
/** Finds the repo-root README (any casing/extension) at commitSha and returns its content, or null if none
 *  exists at that commit. Uses `git ls-tree` to find the real filename rather than guessing a fixed spelling
 *  list. */
async function readReadmeAtCommit(exec, repoPath, commitSha) {
    const listing = await exec("git", ["ls-tree", "--name-only", commitSha], { cwd: repoPath });
    const stdout = assertExecResult(listing, "git_ls_tree_failed");
    const filename = stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => README_NAME_PATTERN.test(line));
    if (!filename)
        return null;
    const shown = await exec("git", ["show", `${commitSha}:${filename}`], { cwd: repoPath });
    const content = assertExecResult(shown, "git_show_readme_failed");
    return { filename, content };
}
/** PURE: fails fast (throws) if any exported commit or tag carries a date LATER than the target commit's own
 *  date. Returns nothing on success. */
export function validateSnapshotFreshness(input) {
    const targetMs = Date.parse(input.targetDate);
    const violations = [];
    for (const commit of input.commits) {
        if (Date.parse(commit.date) > targetMs)
            violations.push(`commit ${commit.sha} dated ${commit.date} is after target ${input.targetDate}`);
    }
    for (const tag of input.tags) {
        if (Date.parse(tag.date) > targetMs)
            violations.push(`tag ${tag.name} dated ${tag.date} is after target ${input.targetDate}`);
    }
    if (violations.length > 0)
        throw new Error(`replay_snapshot_freshness_violation: ${violations.join("; ")}`);
}
export function openReplaySnapshotStore(dbPath = resolveReplaySnapshotDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const db = openLocalStoreDb(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS replay_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      target_date TEXT NOT NULL,
      commits_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      readme_filename TEXT,
      readme_content TEXT,
      exported_at TEXT NOT NULL,
      UNIQUE (repo_full_name, commit_sha)
    )
  `);
    const getStatement = db.prepare("SELECT * FROM replay_snapshots WHERE repo_full_name = ? AND commit_sha = ?");
    const insertStatement = db.prepare(`
    INSERT INTO replay_snapshots
      (repo_full_name, commit_sha, worktree_path, target_date, commits_json, tags_json, readme_filename, readme_content, exported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    function rowToSnapshot(row) {
        return {
            repoFullName: row.repo_full_name,
            commitSha: row.commit_sha,
            worktreePath: row.worktree_path,
            targetDate: row.target_date,
            commits: JSON.parse(row.commits_json),
            tags: JSON.parse(row.tags_json),
            readme: row.readme_filename ? { filename: row.readme_filename, content: row.readme_content } : null,
            exportedAt: row.exported_at,
        };
    }
    return {
        dbPath: resolvedPath,
        getSnapshot(repoFullName, commitSha) {
            const row = getStatement.get(normalizeRepoFullName(repoFullName), normalizeCommitSha(commitSha));
            return row ? rowToSnapshot(row) : null;
        },
        saveSnapshot(snapshot) {
            const repoFullName = normalizeRepoFullName(snapshot.repoFullName);
            const commitSha = normalizeCommitSha(snapshot.commitSha);
            insertStatement.run(repoFullName, commitSha, snapshot.worktreePath, snapshot.targetDate, JSON.stringify(snapshot.commits), JSON.stringify(snapshot.tags), snapshot.readme?.filename ?? null, snapshot.readme?.content ?? null, new Date().toISOString());
            return this.getSnapshot(repoFullName, commitSha);
        },
        close() {
            db.close();
        },
    };
}
function getDefaultReplaySnapshotStore() {
    defaultDb ??= openReplaySnapshotStore();
    return defaultDb;
}
export function closeDefaultReplaySnapshotStore() {
    if (!defaultDb)
        return;
    defaultDb.close();
    defaultDb = null;
}
/**
 * Export a frozen, reproducible replay snapshot for (repoFullName, commitSha): a detached working-tree checkout
 * at that commit plus a context bundle (commit history, reachable tags, README-at-commit). Returns the CACHED
 * snapshot without touching git again if one already exists for this exact (repo, commit) pair.
 */
export async function exportReplaySnapshot(input, deps) {
    if (!input || typeof input !== "object")
        throw new Error("invalid_replay_snapshot_input");
    const repoFullName = normalizeRepoFullName(input.repoFullName);
    const commitSha = normalizeCommitSha(input.commitSha);
    if (typeof input.repoPath !== "string" || !input.repoPath.trim())
        throw new Error("invalid_repo_path");
    const repoPath = input.repoPath.trim();
    if (!deps || typeof deps !== "object" || typeof deps.exec !== "function")
        throw new Error("invalid_exec");
    const { exec } = deps;
    const store = deps.store ?? getDefaultReplaySnapshotStore();
    const cached = store.getSnapshot(repoFullName, commitSha);
    if (cached)
        return cached;
    const worktreePath = planReplaySnapshotPath({ repoPath, commitSha });
    await addDetachedWorktree(exec, repoPath, worktreePath, commitSha);
    // Everything below can fail (a bad git read, or a deliberate freshness violation) after the worktree already
    // exists on disk at the deterministic path above. Left behind, a retry for the same (repo, commit) pair would
    // hit `git worktree add`'s own "path already exists" refusal instead of the real error, permanently masking
    // it. Clean up the worktree on any failure here before rethrowing, so a retry starts from a clean slate.
    try {
        const targetDate = await readTargetCommitDate(exec, repoPath, commitSha);
        const commits = await readCommitHistory(exec, repoPath, commitSha);
        const tags = await readReachableTags(exec, repoPath, commitSha);
        const readme = await readReadmeAtCommit(exec, repoPath, commitSha);
        validateSnapshotFreshness({ targetDate, commits, tags });
        return store.saveSnapshot({ repoFullName, commitSha, worktreePath, targetDate, commits, tags, readme });
    }
    catch (error) {
        await removeReplaySnapshotWorktree(exec, repoPath, worktreePath).catch(() => {
            /* best-effort cleanup -- the original error below is the one that matters to the caller */
        });
        throw error;
    }
}
/** Tear down a replay snapshot's working-tree export (the cached context-bundle row is left in place -- it is
 *  cheap, commit-keyed, and re-usable even after the on-disk tree is removed; only re-adding the worktree would
 *  require the tree again, which is out of this function's scope). */
export async function removeReplaySnapshotWorktree(exec, repoPath, worktreePath) {
    return removeWorktree({ exec, repoPath, worktreePath });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVwbGF5LXNuYXBzaG90LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVwbGF5LXNuYXBzaG90LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFDakMsT0FBTyxFQUFFLGNBQWMsRUFBMkUsTUFBTSxrQkFBa0IsQ0FBQztBQUMzSCxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUseUJBQXlCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUV4Ryw2R0FBNkc7QUFDN0csMEdBQTBHO0FBQzFHLDRHQUE0RztBQUM1RywyR0FBMkc7QUFDM0csd0JBQXdCO0FBQ3hCLCtHQUErRztBQUMvRyw4R0FBOEc7QUFDOUcsOEdBQThHO0FBQzlHLGdIQUFnSDtBQUNoSCxFQUFFO0FBQ0YsNEdBQTRHO0FBQzVHLDhHQUE4RztBQUM5RywyR0FBMkc7QUFDM0csdUdBQXVHO0FBQ3ZHLGdHQUFnRztBQUNoRywyRkFBMkY7QUFDM0Ysd0VBQXdFO0FBQ3hFLEVBQUU7QUFDRix1R0FBdUc7QUFDdkcsNkdBQTZHO0FBQzdHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsdUdBQXVHO0FBQ3ZHLEVBQUU7QUFDRixnSEFBZ0g7QUFDaEgsNkdBQTZHO0FBQzdHLDZHQUE2RztBQUM3RywrR0FBK0c7QUFFL0csTUFBTSxpQkFBaUIsR0FBRyx5QkFBeUIsQ0FBQztBQUNwRCxJQUFJLFNBQVMsR0FBK0IsSUFBSSxDQUFDO0FBRWpELE1BQU0sVUFBVSwyQkFBMkIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBeUM7SUFDckksT0FBTyx1QkFBdUIsQ0FBQyxpQkFBaUIsRUFBRSxtQ0FBbUMsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUM5RixDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsTUFBaUM7SUFDeEQsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsMkJBQTJCLEVBQUUsRUFBRSxpQ0FBaUMsQ0FBQyxD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
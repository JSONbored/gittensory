// Repo-doc PR delivery (#3000, part of the repo-doc generation roadmap #2993). Turns a rendered AGENTS.md body
// (src/review/repo-doc-render.ts, itself derived from src/review/repo-profile.ts) into an actual pull request
// against the target repo -- branch + commit + PR-open, reusing the SAME installation-token write chokepoint
// (makeInstallationOctokit) every other GitHub write in this engine goes through. Never a direct commit to the
// target repo's default branch: AGENTS.md and CLAUDE.md are always delivered as a PR, first-run or refresh alike.
import { withInstallationTokenRetry } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import { getRepository } from "../db/repositories";
import { extractRepoProfile } from "../review/repo-profile";
import { renderRepoDocContent } from "../review/repo-doc-render";
import type { AgentActionMode } from "../settings/agent-execution";

/** Stable across runs (not per-run unique) so a repeat invocation targets the SAME branch/PR instead of piling up
 *  duplicates -- #3004's diff-aware refresh is expected to update commits on this same branch rather than open a
 *  second PR. #3000 itself only needs the "already an open PR on this branch" short-circuit below. */
const REPO_DOC_BRANCH_NAME = "gittensory/repo-docs";
const AGENTS_FILE_PATH = "AGENTS.md";
const CLAUDE_FILE_PATH = "CLAUDE.md";
const PR_TITLE = "docs: generate AGENTS.md and CLAUDE.md from repo profile";

export type RepoDocPullRequestResult =
  | { opened: true; reused: boolean; pullNumber: number; url: string; claudeMode: "symlink" | "copy" }
  | { opened: false; reason: string };

// Non-throwing split (mirrors repo-profile.ts's splitRepoFullName, not pr-actions.ts's throwing splitRepo):
// by the time this runs, `repoFullName` already named a row `getRepository` found, so re-validating its shape
// here would only guard against a state the DB's own invariants already rule out.
function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const slash = repoFullName.indexOf("/");
  return slash === -1 ? { owner: "", repo: repoFullName } : { owner: repoFullName.slice(0, slash), repo: repoFullName.slice(slash + 1) };
}

type DocTreeEntry = { path: string; mode: "100644" | "120000"; type: "blob"; content: string };
type Octokit = ReturnType<typeof makeInstallationOctokit>;

/** Builds the two-file tree (AGENTS.md + CLAUDE.md) atop the branch's current tree in ONE commit, so first-run
 *  (paths absent) and refresh (paths present) are handled identically -- `base_tree` + explicit per-path entries
 *  add-or-replace regardless of whether the path previously existed, with no separate "does it exist yet" probe.
 *  Tries a real symlink (git mode 120000) first; if the target repo/platform rejects that tree, retries with
 *  CLAUDE.md as a byte-identical regular-file copy of AGENTS.md instead (#3000's own documented fallback). */
async function buildRepoDocTree(octokit: Octokit, owner: string, repo: string, baseTreeSha: string, agentsContent: string): Promise<{ treeSha: string; claudeMode: "symlink" | "copy" }> {
  const agentsEntry: DocTreeEntry = { path: AGENTS_FILE_PATH, mode: "100644", type: "blob", content: agentsContent };
  try {
    const symlinkEntry: DocTreeEntry = { path: CLAUDE_FILE_PATH, mode: "120000", type: "blob", content: AGENTS_FILE_PATH };
    const response = await octokit.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, base_tree: baseTreeSha, tree: [agentsEntry, symlinkEntry] });
    return { treeSha: (response.data as { sha: string }).sha, claudeMode: "symlink" };
  } catch {
    const copyEntry: DocTreeEntry = { path: CLAUDE_FILE_PATH, mode: "100644", type: "blob", content: agentsContent };
    const response = await octokit.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, base_tree: baseTreeSha, tree: [agentsEntry, copyEntry] });
    return { treeSha: (response.data as { sha: string }).sha, claudeMode: "copy" };
  }
}

function repoDocPullRequestBody(repoFullName: string): string {
  return `Gittensory opened this pull request on the maintainer's behalf. This is an automated maintenance action, not a manual code review.

## What this is

\`AGENTS.md\`, generated from a profile of ${repoFullName}'s own code -- its indexed file layout, naming and test-file conventions, build/test/lint commands, and contribution-workflow settings (whether CI publishes a required check, the linked-issue policy, and indexed CI workflow files). \`CLAUDE.md\` is kept in sync with it (as a symlink where the platform supports one, otherwise an identical copy), so the two never drift apart.

## Why it looks like this

Every fact above was read directly from this repository, not templated or guessed. If something looks wrong, it most likely means the underlying signal doesn't represent this repo well -- edit the generated file directly on this branch (or after merging) rather than filing an issue against Gittensory.

## Opting out

Disable repo-doc generation for this repository, or simply close this pull request -- no further action is taken until it is re-enabled.
`;
}

/**
 * Generate AGENTS.md/CLAUDE.md from this repo's profile and open (or find the already-open) pull request
 * carrying them. Returns `{ opened: false, reason }` -- never throws -- when: the repo isn't installed, the repo
 * profile has no data yet (#2999's fail-closed branch), `mode` is not `"live"` (dry-run/paused instances must not
 * chain several dependent GitHub writes through synthetic suppressed responses -- see `maybeEscalateModeration`
 * in `agent-action-executor.ts` for the same "no side effect for a write that didn't really happen" guard on a
 * different action), or any step failed partway through. The ENTIRE body runs inside one try/catch (not just the
 * GitHub-write chain) so a failure in the repo/profile lookups themselves is reported the same honest way,
 * rather than propagating as an uncaught exception from what the rest of the engine treats as a fail-safe call.
 */
export async function openRepoDocPullRequest(env: Env, repoFullName: string, mode: AgentActionMode): Promise<RepoDocPullRequestResult> {
  try {
    const repository = await getRepository(env, repoFullName);
    if (!repository?.installationId) return { opened: false, reason: "repository is not installed" };

    const profile = await extractRepoProfile(env, repoFullName);
    if (!profile.present) return { opened: false, reason: profile.reason };
    const agentsContent = renderRepoDocContent(profile);
    if (!agentsContent) return { opened: false, reason: "no content rendered from profile" };

    if (mode !== "live") return { opened: false, reason: `repo-doc pull request not opened: action mode is "${mode}"` };

    const { owner, repo } = splitRepo(repoFullName);
    const installationId = repository.installationId;
    return await withInstallationTokenRetry(env, installationId, async (token) => {
      const octokit = makeInstallationOctokit(env, token, mode, githubRateLimitAdmissionKeyForInstallation(installationId));

      const baseBranch = repository.defaultBranch ?? (await octokit.request("GET /repos/{owner}/{repo}", { owner, repo })).data.default_branch;

      const existingOpenPrs = await octokit.request("GET /repos/{owner}/{repo}/pulls", { owner, repo, state: "open", head: `${owner}:${REPO_DOC_BRANCH_NAME}`, base: baseBranch });
      const existing = (existingOpenPrs.data as Array<{ number: number; html_url: string }>)[0];
      if (existing) return { opened: true, reused: true, pullNumber: existing.number, url: existing.html_url, claudeMode: "symlink" };

      const branchInfo = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch: baseBranch });
      const baseCommitSha = branchInfo.data.commit.sha;
      const baseTreeSha = branchInfo.data.commit.commit.tree.sha;

      const { treeSha, claudeMode } = await buildRepoDocTree(octokit, owner, repo, baseTreeSha, agentsContent);

      const commit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", { owner, repo, message: PR_TITLE, tree: treeSha, parents: [baseCommitSha] });
      const commitSha = (commit.data as { sha: string }).sha;

      await octokit.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: `refs/heads/${REPO_DOC_BRANCH_NAME}`, sha: commitSha });

      const pr = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        title: PR_TITLE,
        body: repoDocPullRequestBody(repoFullName),
        head: REPO_DOC_BRANCH_NAME,
        base: baseBranch,
        maintainer_can_modify: true,
      });
      const prData = pr.data as { number: number; html_url: string };
      return { opened: true, reused: false, pullNumber: prData.number, url: prData.html_url, claudeMode };
    });
  } catch (error) {
    return { opened: false, reason: error instanceof Error ? error.message : "unknown error opening repo-doc pull request" };
  }
}

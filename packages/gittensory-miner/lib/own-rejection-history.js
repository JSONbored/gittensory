import { listRecentOwnSubmissions } from "./governor-state.js";
import { extractPrOutcomeFields, isRejectedPr } from "./rejection-state-machine.js";

// #5655: the SECOND documented `rejectionSignaled` trigger (iterate-policy.ts's doc comment) — has THIS miner's
// own prior submission on the target repo already been closed without merge? `resolveRejectionSignaled` only
// resolved the first trigger (the live AI-usage-policy ban); this wires together two already-shipped, already-
// tested modules (`listRecentOwnSubmissions` #5134 + the rejection-state-machine's `isRejectedPr`/`extractPrOutcomeFields`
// #4278) for that use, without modifying either. Fails open: a bad fetch/list never blocks or fabricates.

const GITHUB_API_BASE = "https://api.github.com";
// Cap the PR-status fetches per call so a miner with a long history on one repo can't fan out unbounded API
// calls on every single attempt (deliverable #2).
const DEFAULT_MAX_FETCHES = 5;

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra) return null;
  return { owner, repo };
}

/** Fetch a single PR's current state via REST, mirroring this package's existing GitHub-fetch conventions
 *  (injectable `fetchImpl`, `loopover-miner` user-agent, optional bearer auth from `githubToken`/env). Throws
 *  on a non-OK response so the caller's per-PR fail-open path handles it. The credential is never logged. */
async function fetchPullRequestState(target, number, options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const credential = (options.githubToken ?? process.env.GITHUB_TOKEN ?? "").trim();
  const apiBase = options.apiBaseUrl ?? GITHUB_API_BASE;
  const headers = { accept: "application/vnd.github+json", "user-agent": "loopover-miner" };
  if (credential) headers.authorization = `Bearer ${credential}`;
  const response = await fetchImpl(`${apiBase}/repos/${target.owner}/${target.repo}/pulls/${number}`, {
    method: "GET",
    headers,
  });
  if (!response.ok) throw new Error(`pr_status_fetch_failed:${response.status}`);
  return response.json();
}

/**
 * Resolve whether ANY of this miner's own recent prior submissions on `repoFullName` was closed without merge
 * (a "was it rejected" check over real GitHub PR state — the second `rejectionSignaled` trigger).
 *
 * @param {string} repoFullName `owner/repo`.
 * @param {{ fetchImpl?: typeof fetch, githubToken?: string, apiBaseUrl?: string, maxFetches?: number,
 *   listSubmissions?: (filter: { repoFullName: string }) => Array<{ pullRequestNumber?: number }> }} [options]
 *   `listSubmissions` is injectable for tests; it defaults to the real `listRecentOwnSubmissions`.
 * @returns {Promise<boolean>} `true` iff a prior own submission on this repo is closed-without-merge.
 */
export async function resolveOwnRejectionHistory(repoFullName, options = {}) {
  const target = parseRepoFullName(repoFullName);
  if (!target) return false;
  const listSubmissions = options.listSubmissions ?? listRecentOwnSubmissions;
  const max = Number.isInteger(options.maxFetches) && options.maxFetches > 0 ? options.maxFetches : DEFAULT_MAX_FETCHES;

  let candidates;
  try {
    candidates = listSubmissions({ repoFullName })
      .filter((submission) => Number.isInteger(submission?.pullRequestNumber))
      .slice(0, max);
  } catch {
    // Wholesale failure (e.g. the submissions store is unavailable) → false, not a fabricated rejection, and
    // not silently swallowed either — the degraded check is surfaced.
    console.error(JSON.stringify({ level: "warn", event: "own_rejection_history_list_failed", repo: repoFullName }));
    return false;
  }

  for (const submission of candidates) {
    try {
      const payload = await fetchPullRequestState(target, submission.pullRequestNumber, options);
      if (isRejectedPr(extractPrOutcomeFields(payload))) return true;
    } catch {
      // Per-PR fail-open: one unreachable/unparseable PR must never block resolution of the others.
      console.error(
        JSON.stringify({
          level: "warn",
          event: "own_rejection_history_pr_check_failed",
          repo: repoFullName,
          pr: submission.pullRequestNumber,
        }),
      );
    }
  }
  return false;
}

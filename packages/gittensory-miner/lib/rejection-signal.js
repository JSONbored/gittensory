import { resolveAiPolicyVerdict } from "@loopover/engine";
import { listRecentOwnSubmissions } from "./governor-state.js";
import { resolveRejection } from "./rejection-state-machine.js";

// Real rejectionSignaled resolver (#5132, Wave 3.5 follow-up). iterate-policy.ts's own doc comment: "True
// when the target repo (or this contributor's history with it) has signaled it does not want automated/
// AI-authored contributions -- an explicit AI-usage-policy ban, or a prior submission from this same miner
// was closed/rejected on this exact repo. The caller resolves this ... and passes it in; this policy does
// not compute it itself." This module resolves the FIRST trigger: a real AI-USAGE.md/CONTRIBUTING.md ban,
// fetched live and scanned via the engine's own resolveAiPolicyVerdict -- the same check
// opportunity-fanout.js already runs during discovery, applied here at attempt time instead.
//
// The SECOND trigger (a prior submission from this same miner was closed/rejected on this exact repo) is
// DELIBERATELY not resolved here: it would need each of this miner's recorded own-submissions
// (governor-state.js's listRecentOwnSubmissions, #5134) checked against its live PR outcome via
// rejection-state-machine.js's resolveRejection -- a second, separately-scoped fetch-and-classify pipeline.
// Not fabricated as "no rejection history" -- explicitly left as a known, documented gap for a follow-up,
// same discipline as SelfReviewContext's bounties/issueQuality (#5145) and this file's own callers should
// not assume a false result here means "no rejection signal of any kind."

const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";
const MAX_POLICY_DOC_BYTES = 128 * 1024;
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
// Bound the per-attempt fan-out of PR-status fetches: only the N most recent own-submissions on this repo are
// checked, so a miner with a long history on one repo can't trigger an unbounded burst of GitHub API calls on
// every single attempt (#5655 req 2).
const DEFAULT_MAX_OWN_SUBMISSIONS = 10;

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return { owner, repo };
}

function normalizeOptions(options = {}) {
  return {
    rawContentBaseUrl:
      typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

async function readBoundedPolicyDoc(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== undefined && contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_POLICY_DOC_BYTES) return null;
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    return typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_POLICY_DOC_BYTES ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_POLICY_DOC_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchPolicyDoc(target, path, resolved) {
  const url = `${resolved.rawContentBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/HEAD/${path}`;
  try {
    const response = await resolved.fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": "loopover-miner" } });
    if (!response.ok) return null;
    return await readBoundedPolicyDoc(response);
  } catch {
    return null;
  }
}

/**
 * Resolve `rejectionSignaled`'s SECOND documented trigger: whether a prior submission from THIS miner on this
 * exact repo was closed WITHOUT a merge. Reads this miner's own recorded submissions
 * (governor-state.js's `listRecentOwnSubmissions`), fetches each one's live `GET /pulls/{n}` state, and
 * classifies it via rejection-state-machine.js's `resolveRejection`. Returns true if ANY is a rejection.
 *
 * Fail-open, never fabricated: an individual unreachable/unparseable PR is skipped so it can't block the
 * others, and a wholesale failure to even list submissions resolves to `false` — a DEGRADED check surfaced via
 * a warning, never silently asserted as "definitely no rejection". `githubToken`/`apiBaseUrl`/`maxSubmissions`/
 * `fetchImpl`/`listRecentOwnSubmissions` are injectable purely for testability; every real caller uses the
 * defaults (`process.env.GITHUB_TOKEN`, the public API, `node:fetch`, the real governor-state reader).
 *
 * @param {string} repoFullName
 * @param {{ githubToken?: string, apiBaseUrl?: string, maxSubmissions?: number,
 *   fetchImpl?: import("./self-review-context.js").SelfReviewContextFetch,
 *   listRecentOwnSubmissions?: typeof listRecentOwnSubmissions }} [options]
 * @returns {Promise<boolean>}
 */
export async function resolveOwnRejectionHistory(repoFullName, options = {}) {
  const target = parseRepoFullName(repoFullName);
  if (!target) return false;

  const listSubmissions = options.listRecentOwnSubmissions ?? listRecentOwnSubmissions;
  const fetchImpl = options.fetchImpl ?? fetch;
  const githubToken = (typeof options.githubToken === "string" ? options.githubToken : process.env.GITHUB_TOKEN ?? "").trim();
  const apiBaseUrl =
    typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl.trim() : DEFAULT_GITHUB_API_BASE_URL;
  const maxSubmissions =
    Number.isInteger(options.maxSubmissions) && options.maxSubmissions > 0 ? options.maxSubmissions : DEFAULT_MAX_OWN_SUBMISSIONS;

  let submissions;
  try {
    submissions = listSubmissions({ repoFullName, limit: maxSubmissions });
  } catch (error) {
    // Wholesale failure: surface the degraded check, resolve false (never fabricated as a rejection).
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "own_rejection_history_unavailable",
        repoFullName,
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }

  const prNumbers = (Array.isArray(submissions) ? submissions : [])
    .map((submission) => submission?.pullRequestNumber)
    .filter((prNumber) => Number.isInteger(prNumber) && prNumber > 0)
    .slice(0, maxSubmissions);

  const headers = { accept: "application/vnd.github+json", "user-agent": "loopover-miner" };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;

  for (const prNumber of prNumbers) {
    try {
      const url = `${apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${prNumber}`;
      const response = await fetchImpl(url, { method: "GET", headers });
      if (!response.ok) continue;
      const payload = await response.json();
      // No gate/duplicate signal here (unavailable and unneeded) — just "was it closed without merge".
      if (resolveRejection(payload, undefined, { repoFullName, prNumber }) !== null) return true;
    } catch {
      // Fail-open per PR: one unreachable/unparseable submission must never block the others.
    }
  }
  return false;
}

/**
 * Resolve `rejectionSignaled` from BOTH of its documented triggers (matching iterate-policy.ts's own doc
 * comment for the first time): `true` when EITHER the target repo has an explicit, live AI-usage-policy ban,
 * OR a prior submission from this same miner on this exact repo was closed without merge. Returns `false`
 * (never throws) on any fetch/parse failure, matching each underlying resolver's fail-open default.
 *
 * @param {string} repoFullName
 * @param {{ rawContentBaseUrl?: string, githubToken?: string, apiBaseUrl?: string, maxSubmissions?: number,
 *   fetchImpl?: import("./self-review-context.js").SelfReviewContextFetch,
 *   listRecentOwnSubmissions?: typeof listRecentOwnSubmissions }} [options]
 * @returns {Promise<boolean>}
 */
export async function resolveRejectionSignaled(repoFullName, options = {}) {
  const target = parseRepoFullName(repoFullName);
  if (!target) return false;
  const resolved = normalizeOptions(options);

  // Trigger 1: an explicit, live AI-usage-policy ban.
  const aiUsage = await fetchPolicyDoc(target, "AI-USAGE.md", resolved);
  const contributing = aiUsage && aiUsage.trim() ? null : await fetchPolicyDoc(target, "CONTRIBUTING.md", resolved);
  const verdict = resolveAiPolicyVerdict({ aiUsage, contributing });
  if (!verdict.allowed) return true;

  // Trigger 2: a prior submission from this same miner on this exact repo was closed without merge. Only checked
  // when trigger 1 is clear, so a repo that already bans AI contributions costs zero extra PR-status fetches.
  return resolveOwnRejectionHistory(repoFullName, options);
}

// History analyzer (#1697 / #1478). Uses PR metadata plus engine-prefetched GitHub context when provided.
// Fail-safe: without prefetch, parses linked issues from the body only (no GitHub API in REES).
import type { EnrichRequest, HistoryFinding, LinkedIssueFinding } from "../types.js";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_LINKED_ISSUES = 8;
const MAX_BODY_CHARS = 8000;

const LINKED_ISSUE_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*)?#(\d+)\b/gi;

/** Parse `Fixes #123` / `Closes org/repo#456` references from the PR body. Pure. */
export function extractLinkedIssues(
  body: string | undefined,
  defaultRepo: string,
): Array<{ repo: string; number: number }> {
  const text = (body ?? "").slice(0, MAX_BODY_CHARS);
  const seen = new Set<string>();
  const linked: Array<{ repo: string; number: number }> = [];
  for (const match of text.matchAll(LINKED_ISSUE_RE)) {
    const owner = match[1];
    const repo = match[2];
    const number = Number(match[3]);
    if (!Number.isFinite(number) || number <= 0) continue;
    const repoFullName =
      owner && repo ? `${owner}/${repo}` : defaultRepo;
    const key = `${repoFullName}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    linked.push({ repo: repoFullName, number });
    if (linked.length >= MAX_LINKED_ISSUES) break;
  }
  return linked;
}

/** Body-only history fallback when the engine did not prefetch GitHub API results. */
function historyFromBodyOnly(
  req: EnrichRequest,
): HistoryFinding | null {
  const author = req.author?.replace(/^@/, "") ?? "";
  if (!author) return null;
  const linkedIssues: LinkedIssueFinding[] = extractLinkedIssues(
    req.body,
    req.repoFullName,
  ).map((ref) => ({
    number: ref.number,
    repo: ref.repo,
    state: null,
    title: null,
    aligned: true,
  }));
  if (!linkedIssues.length) {
    return {
      authorLogin: author,
      mergedPrCount: null,
      authorTier: "unknown",
      linkedIssues: [],
    };
  }
  return {
    authorLogin: author,
    mergedPrCount: null,
    authorTier: "unknown",
    linkedIssues,
  };
}

/** Analyzer entrypoint: use engine prefetch when present; otherwise body-only parsing. */
export async function scanHistory(
  req: EnrichRequest,
): Promise<HistoryFinding | null> {
  if (req.prefetch && "history" in req.prefetch) {
    return req.prefetch.history ?? null;
  }
  return historyFromBodyOnly(req);
}

// Retained for REES unit tests that exercise GitHub search helpers directly.
export function classifyAuthorTier(
  mergedCount: number | null,
): HistoryFinding["authorTier"] {
  if (mergedCount === null) return "unknown";
  return mergedCount < 3 ? "newcomer" : "established";
}

export async function fetchAuthorMergedCount(
  repoFullName: string,
  author: string,
  githubToken: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!SLUG_RE.test(author.replace(/^@/, ""))) return null;
  const q = encodeURIComponent(
    `repo:${repoFullName} author:${author.replace(/^@/, "")} is:pr is:merged`,
  );
  try {
    const resp = await fetchFn(
      `https://api.github.com/search/issues?q=${q}&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
      },
    );
    if (!resp.ok) return null;
    const payload = (await resp.json()) as { total_count?: number };
    return typeof payload.total_count === "number" ? payload.total_count : null;
  } catch {
    return null;
  }
}

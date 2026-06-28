// Revert-recurrence detector (#1514). Fetches per-file commit history from the GitHub commits API, finds revert
// commits (message starts with "Revert"), fetches their diffs, and intersects the lines they removed with the
// lines being added in the current PR. A hit means known-problematic code is being re-introduced without
// addressing the original reason it was reverted. Fail-safe: network errors + non-ok responses → empty findings.
import type { EnrichRequest, RevertRecurrenceFinding } from "../types.js";

const MAX_FILES = 10;
const MAX_COMMITS_PER_FILE = 30;
const MAX_REVERT_CHECKS_PER_FILE = 5;
const MAX_FINDINGS = 15;
// Two matching non-trivial lines are required to suppress coincidental hits on common structural patterns.
const MIN_MATCH_LINES = 2;
const MIN_LINE_LEN = 8;
const MAX_SHA_DISPLAY = 7;
const MAX_MSG_CHARS = 80;

type FetchImpl = typeof fetch;

/** True when the commit message begins with a revert keyword (standard `git revert` format or manual label). */
export function isRevertMessage(msg: string): boolean {
  return /^[Rr]evert\b/.test(msg.trimStart());
}

/** Extract non-trivial lines added by a patch (`+` lines, excluding the `+++` header). */
export function extractAddedLines(patch: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const content = raw.slice(1).trim();
      if (content.length >= MIN_LINE_LEN) lines.add(content);
    }
  }
  return lines;
}

/** Extract non-trivial lines removed by a patch (`-` lines, excluding the `---` header). */
export function extractRemovedLines(patch: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      const content = raw.slice(1).trim();
      if (content.length >= MIN_LINE_LEN) lines.add(content);
    }
  }
  return lines;
}

function githubHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function listFileCommits(
  repoFullName: string,
  path: string,
  sha: string | undefined,
  token: string | undefined,
  fetchImpl: FetchImpl,
  signal?: AbortSignal,
): Promise<Array<{ sha: string; commit: { message: string } }>> {
  try {
    const shaParam = sha ? `&sha=${encodeURIComponent(sha)}` : "";
    const url = `https://api.github.com/repos/${repoFullName}/commits?path=${encodeURIComponent(path)}&per_page=${MAX_COMMITS_PER_FILE}${shaParam}`;
    const resp = await fetchImpl(url, { headers: githubHeaders(token), signal });
    if (!resp.ok) return [];
    const raw = await resp.json();
    return Array.isArray(raw)
      ? (raw as Array<{ sha: string; commit: { message: string } }>)
      : [];
  } catch {
    return [];
  }
}

async function fetchCommitFiles(
  repoFullName: string,
  sha: string,
  token: string | undefined,
  fetchImpl: FetchImpl,
  signal?: AbortSignal,
): Promise<Array<{ filename: string; patch?: string }>> {
  try {
    const url = `https://api.github.com/repos/${repoFullName}/commits/${encodeURIComponent(sha)}`;
    const resp = await fetchImpl(url, { headers: githubHeaders(token), signal });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      files?: Array<{ filename: string; patch?: string }>;
    };
    return data.files ?? [];
  } catch {
    return [];
  }
}

/** Scan the PR's added lines for content previously removed by a revert commit in the same file's history. */
export async function scanRevertRecurrence(
  req: EnrichRequest,
  fetchImpl: FetchImpl = fetch,
  options: { signal?: AbortSignal } = {},
): Promise<RevertRecurrenceFinding[]> {
  const { signal } = options;
  const files = (req.files ?? []).filter((f) => f.patch);
  const findings: RevertRecurrenceFinding[] = [];

  for (const file of files.slice(0, MAX_FILES)) {
    if (findings.length >= MAX_FINDINGS || signal?.aborted) break;

    const prAdded = extractAddedLines(file.patch!);
    if (prAdded.size === 0) continue;

    const commits = await listFileCommits(
      req.repoFullName,
      file.path,
      req.baseSha,
      req.githubToken,
      fetchImpl,
      signal,
    );

    let revertChecks = 0;
    for (const commit of commits) {
      if (
        findings.length >= MAX_FINDINGS ||
        revertChecks >= MAX_REVERT_CHECKS_PER_FILE ||
        signal?.aborted
      )
        break;
      if (!isRevertMessage(commit.commit.message)) continue;
      revertChecks++;

      const commitFiles = await fetchCommitFiles(
        req.repoFullName,
        commit.sha,
        req.githubToken,
        fetchImpl,
        signal,
      );
      const target = commitFiles.find((cf) => cf.filename === file.path);
      if (!target?.patch) continue;

      // In a revert commit, `-` lines are the code that was being reverted (originally introduced then walked back).
      // If the current PR re-adds those lines, that's a recurrence.
      const revertRemoved = extractRemovedLines(target.patch);
      const matchCount = [...prAdded].filter((l) => revertRemoved.has(l)).length;
      if (matchCount < MIN_MATCH_LINES) continue;

      findings.push({
        file: file.path,
        revertSha: commit.sha.slice(0, MAX_SHA_DISPLAY),
        revertMessage: commit.commit.message.split("\n")[0]!.slice(0, MAX_MSG_CHARS),
        matchedLines: matchCount,
      });
    }
  }

  return findings;
}

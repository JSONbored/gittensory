// Engine-side CODEOWNERS prefetch (#1697). Installation tokens stay in the engine —
// REES receives only derived findings via EnrichmentPrefetch, never raw credentials.
import {
  authorMatchesOwner,
  findOwners,
  parseCodeowners,
} from "../../review-enrichment/src/analyzers/codeowners.js";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;
const MAX_FILES_REPORTED = 20;

export interface CodeownersPrefetchFinding {
  file: string;
  owners: string[];
}

async function fetchCodeownersContent(
  owner: string,
  repo: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const resp = await fetchFn(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`,
        signal ? { headers, signal } : { headers },
      );
      if (!resp.ok) continue;
      return await resp.text();
    } catch {
      // network error or aborted signal → try next location
    }
  }
  return null;
}

/** Match changed files against parsed CODEOWNERS text; report author-absent violations. */
export function matchCodeownersViolations(
  content: string,
  author: string,
  files: Array<{ path: string }>,
): CodeownersPrefetchFinding[] {
  const rules = parseCodeowners(content);
  if (rules.length === 0) return [];

  const findings: CodeownersPrefetchFinding[] = [];
  for (const file of files) {
    if (findings.length >= MAX_FILES_REPORTED) break;
    const owners = findOwners(rules, file.path);
    if (owners.length === 0) continue;
    if (authorMatchesOwner(author, owners)) continue;
    findings.push({ file: file.path, owners });
  }
  return findings;
}

/** Fetch CODEOWNERS from GitHub and return author-absent violations (engine prefetch). */
export async function prefetchCodeownersFindings(
  repoFullName: string,
  author: string,
  files: Array<{ path: string }>,
  githubToken: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CodeownersPrefetchFinding[]> {
  if (!githubToken || !author) return [];

  const parts = repoFullName.split("/");
  const repoOwner = parts[0];
  const repoName = parts[1];
  if (
    !repoOwner ||
    !repoName ||
    !SLUG_RE.test(repoOwner) ||
    !SLUG_RE.test(repoName)
  ) {
    return [];
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const content = await fetchCodeownersContent(
    repoOwner,
    repoName,
    headers,
    fetchFn,
    signal,
  );
  if (!content) return [];

  return matchCodeownersViolations(content, author, files);
}

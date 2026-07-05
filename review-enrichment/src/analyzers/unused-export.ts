// Unused-export / dead-on-arrival scan (#2025, part of #1499). Flags exports NEWLY ADDED by the PR that have
// zero non-declaration references anywhere in the repo — net-new public surface nobody calls yet. Parses added
// top-level `export` declarations from the diff, then resolves each symbol via GitHub Code Search (repo-scoped,
// injected fetch). Deliberately conservative + fail-safe: strict maxSymbols + maxSearches caps; a missing
// token/head-sha, an unresolvable repo slug, or any search error yields no finding for that symbol rather than
// an error. Scope is strictly net-new exports only — changed/removed exports with live callers belong in #1509.
import type { AnalyzerDiagnostics, EnrichRequest, UnusedExportFinding } from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { exportedSymbols, parseAddedExports } from "./undocumented-export.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_SYMBOLS = 20;
const MAX_SEARCHES = 15;
const MAX_FINDINGS = 25;
const SEARCH_PER_PAGE = 5;
const MAX_SEARCH_JSON_BYTES = 256 * 1024;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const SKIP_RE = /(?:\.d\.ts$|\.min\.|\.test\.|\.spec\.|__tests__\/|(?:^|\/)(?:dist|build|vendor)\/)/;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
  maxSymbols?: number;
  maxSearches?: number;
}

interface AddedExport {
  file: string;
  line: number;
  symbol: string;
}

interface CodeSearchItem {
  path?: string;
  text_matches?: Array<{ fragment?: string }>;
}

interface CodeSearchResponse {
  total_count?: number;
  items?: CodeSearchItem[];
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
}

/** Collect added direct export declarations across changed files, bounded by maxSymbols. Pure. */
export function collectAddedExports(
  files: NonNullable<EnrichRequest["files"]>,
  maxSymbols = MAX_SYMBOLS,
): AddedExport[] {
  const out: AddedExport[] = [];
  for (const file of files) {
    if (!file.patch || SKIP_RE.test(file.path)) continue;
    for (const { symbol, newLine } of parseAddedExports(file.patch)) {
      out.push({ file: file.path, line: newLine, symbol });
      if (out.length >= maxSymbols) return out;
    }
  }
  return out;
}

/** True when every text-match fragment in a same-file search hit looks like the export declaration itself (not a
 *  use site). Pure — conservative: an ambiguous fragment is treated as a reference so we don't false-flag. */
export function fragmentsLookLikeExportDeclaration(symbol: string, fragments: string[]): boolean {
  if (!fragments.length) return false;
  for (const fragment of fragments) {
    for (const line of fragment.split("\n")) {
      if (!exportedSymbols(line).includes(symbol)) return false;
    }
  }
  return true;
}

/** Decide whether a bounded code-search response shows any non-declaration reference to `symbol`. Pure. */
export function symbolHasNonDeclarationReference(
  symbol: string,
  declFile: string,
  search: CodeSearchResponse,
): boolean {
  const total = search.total_count ?? 0;
  const items = search.items ?? [];
  if (total === 0) return false;
  for (const item of items) {
    if (!item.path) continue;
    if (item.path !== declFile) return true;
    const fragments = (item.text_matches ?? []).map((m) => m.fragment ?? "").filter(Boolean);
    if (!fragmentsLookLikeExportDeclaration(symbol, fragments)) return true;
  }
  // Every returned hit is the declaration in the declaring file. If GitHub reports more hits than we fetched,
  // assume at least one is a real reference — conservative, avoids false positives on popular tokens.
  if (total > items.length) return true;
  return total > 1;
}

async function fetchCodeSearch(
  query: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<CodeSearchResponse | null> {
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(query)}&per_page=${SEARCH_PER_PAGE}`;
  const fetchOptions = {
    endpointCategory: "github-code-search",
    headers: githubHeaders(token),
    signal: options.signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "unused-export",
    subcall: "github-code-search",
    maxBytes: MAX_SEARCH_JSON_BYTES,
    maxCallsPerCategory: options.maxSearches ?? MAX_SEARCHES,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<CodeSearchResponse>(url, fetchOptions)
    : await boundedFetchJson<CodeSearchResponse>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Build a repo-scoped code-search query for `symbol`. Pure. */
export function codeSearchQuery(owner: string, repo: string, symbol: string): string {
  return `repo:${owner}/${repo} ${symbol}`;
}

/** Analyzer entrypoint: flag newly-added exports with zero non-declaration references. Fail-safe. */
export async function scanUnusedExport(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<UnusedExportFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];

  const parts = repoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const maxSymbols = options.maxSymbols ?? MAX_SYMBOLS;
  const maxSearches = options.maxSearches ?? MAX_SEARCHES;
  const candidates = collectAddedExports(files, maxSymbols);
  if (!candidates.length) return [];

  const findings: UnusedExportFinding[] = [];
  let searches = 0;

  for (const { file, line, symbol } of candidates) {
    if (options.signal?.aborted) break;
    if (searches >= maxSearches) break;

    let search: CodeSearchResponse | null = null;
    try {
      search = await fetchCodeSearch(codeSearchQuery(owner, repo, symbol), githubToken, fetchFn, {
        ...options,
        maxSearches,
      });
    } catch {
      search = null;
    }
    searches += 1;
    if (!search) continue;
    if (options.signal?.aborted) break;

    if (!symbolHasNonDeclarationReference(symbol, file, search)) {
      findings.push({ file, line, symbol });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

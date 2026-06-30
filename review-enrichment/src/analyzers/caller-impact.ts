// Cross-file caller-impact + dead-symbol analyzer (#1509). Detects top-level export declarations
// removed from the PR diff that are still called in unchanged files, changed exports with still-live callsites,
// renamed export surfaces (alias migration), and added exports that are currently unreferenced.
import type {
  AnalyzerDiagnostics,
  CallerImpactFinding,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson, boundedFetchText } from "../external-fetch.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_SYMBOLS = 18; // cap PR-derived symbols so one analyzer run stays bounded
const MAX_SEARCH_RESULTS = 30; // per-symbol cap
const MAX_CALLERS_PER_SYMBOL = 8; // keep findings short enough for prompt budget
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const IDENT_RE_STR = "[A-Za-z_$][A-Za-z0-9_$]*";
const IDENT_BOUNDARY = `${IDENT_RE_STR}(?=[^A-Za-z0-9_$]|$)`;

interface ParsedExport {
  file: string;
  line: number;
  symbol: string;
  localSymbol: string;
  side: "added" | "removed";
  usesAlias: boolean;
}

interface SearchPayload {
  path: string;
}

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson" | "fetchText">;
  diagnostics?: AnalyzerDiagnostics;
}

function parseRepo(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return null;
  return { owner, repo };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
}

function encodePath(path: string): string | null {
  if (!path) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    return null;
  return segments.map(encodeURIComponent).join("/");
}

function safeSymbol(symbol: string): boolean {
  return IDENT_RE.test(symbol) && symbol.length <= 80;
}

function symbolBoundaryRegex(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^A-Za-z0-9_$])(${escaped})(?:$|[^A-Za-z0-9_$])`,
  );
}

function patchEntries(patch: string): Array<{
  side: "added" | "removed";
  line: number;
  content: string;
}> {
  const entries: Array<{
    side: "added" | "removed";
    line: number;
    content: string;
  }> = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of patch.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1]!, 10);
      newLine = Number.parseInt(hunk[2]!, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
    if (rawLine.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("+")) {
      entries.push({ side: "added", line: newLine, content: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      entries.push({ side: "removed", line: oldLine, content: rawLine.slice(1) });
      oldLine += 1;
    }
  }
  return entries;
}

function parseExportLines(line: string): Array<{
  local: string;
  symbol: string;
  usesAlias: boolean;
}> {
  const declaration = new RegExp(
    `^\\s*export\\s+(?:default\\s+)?(?:(?:async\\s+)?function|class|interface|type|enum|const|let|var|namespace)\\s+(${IDENT_BOUNDARY})`,
  ).exec(line);
  if (declaration) {
    const symbol = declaration[1];
    if (!symbol || !IDENT_RE.test(symbol)) return [];
    return [{ local: symbol, symbol, usesAlias: false }];
  }

  const namespaceAs = new RegExp(`^\\s*export\\s*\\*\\s+as\\s+(${IDENT_BOUNDARY})`).exec(
    line,
  );
  if (namespaceAs) {
    const symbol = namespaceAs[1];
    if (!symbol || !IDENT_RE.test(symbol)) return [];
    return [{ local: "*", symbol, usesAlias: false }];
  }

  const exports = /^\s*export\s*\{([^}]*)\}\s*(?:from\s+["'][^"']+["'])?\s*;?/.exec(line);
  if (!exports) return [];

  return (exports[1] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const alias = new RegExp(
        `^((?:default)|${IDENT_RE_STR})\\s+as\\s+(${IDENT_RE_STR})$`,
      ).exec(item);
      if (alias && IDENT_RE.test(alias[1]!) && IDENT_RE.test(alias[2]!)) {
        return {
          local: alias[1]!,
          symbol: alias[2]!,
          usesAlias: true,
        };
      }
      if (IDENT_RE.test(item)) return { local: item, symbol: item, usesAlias: false };
      return null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function extractExportsFromPatch(filePath: string, patch: string): ParsedExport[] {
  const parsed: ParsedExport[] = [];
  for (const entry of patchEntries(patch)) {
    for (const decl of parseExportLines(entry.content)) {
      parsed.push({
        file: filePath,
        line: entry.line,
        symbol: decl.symbol,
        localSymbol: decl.local,
        side: entry.side,
        usesAlias: decl.usesAlias,
      });
    }
  }
  return parsed;
}

function collectFromPatch(
  files: NonNullable<EnrichRequest["files"]>,
): {
  added: ParsedExport[];
  removed: ParsedExport[];
  changedPaths: Set<string>;
} {
  const added: ParsedExport[] = [];
  const removed: ParsedExport[] = [];
  const changedPaths = new Set<string>();

  for (const file of files) {
    changedPaths.add(file.path);
    if (!file.patch) continue;
    const entries = extractExportsFromPatch(file.path, file.patch);
    for (const entry of entries) {
      if (entry.side === "added") added.push(entry);
      else removed.push(entry);
    }
  }

  return { added, removed, changedPaths };
}

async function searchUsages(
  owner: string,
  repo: string,
  symbol: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions = {},
): Promise<string[]> {
  if (!safeSymbol(symbol)) return [];
  const query = `\"${symbol}\" repo:${owner}/${repo} in:file`;
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(query)}&per_page=${MAX_SEARCH_RESULTS}`;
  const headers = githubHeaders(token);

  try {
    const response = options.analysis
      ? await options.analysis.fetchJson<{ items?: SearchPayload[] }>(url, {
          endpointCategory: "github-search-code",
          headers,
          method: "GET",
          signal: options.signal,
          fetchImpl,
          diagnostics: options.diagnostics,
          phase: "callerImpact",
          subcall: "github-search-code",
          maxBytes: 256 * 1024,
        })
      : await boundedFetchJson<{ items?: SearchPayload[] }>(url, {
          endpointCategory: "github-search-code",
          headers,
          method: "GET",
          signal: options.signal,
          fetchImpl,
          diagnostics: options.diagnostics,
          phase: "callerImpact",
          subcall: "github-search-code",
          maxBytes: 256 * 1024,
        });
    if (!response.ok) return [];
    const payload = response.data;
    const paths = (payload.items ?? [])
      .map((item) => item.path)
      .filter((path): path is string => Boolean(path))
      .filter((path, index, list) => list.indexOf(path) === index);

    return paths;
  } catch {
    return [];
  }
}

async function readFileContainsSymbol(
  owner: string,
  repo: string,
  path: string,
  symbol: string,
  headSha: string,
  token: string,
  fetchImpl: typeof fetch,
  skipLineNumbers: ReadonlySet<number> = new Set(),
  options: ScanOptions = {},
): Promise<boolean> {
  const encodedPath = encodePath(path);
  if (!encodedPath) return false;
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(headSha)}`;

  try {
    const response = options.analysis
      ? await options.analysis.fetchText(url, {
          endpointCategory: "github-contents-raw",
          headers: { ...githubHeaders(token), Accept: "application/vnd.github.raw" },
          method: "GET",
          signal: options.signal,
          fetchImpl,
          diagnostics: options.diagnostics,
          phase: "callerImpact",
          subcall: "github-contents-raw",
          maxBytes: 768 * 1024,
        })
      : await boundedFetchText(url, {
          endpointCategory: "github-contents-raw",
          headers: { ...githubHeaders(token), Accept: "application/vnd.github.raw" },
          method: "GET",
          signal: options.signal,
          fetchImpl,
          diagnostics: options.diagnostics,
          phase: "callerImpact",
          subcall: "github-contents-raw",
          maxBytes: 768 * 1024,
        });
    if (!response.ok) return false;
    const text = response.data;
    const lineRegex = symbolBoundaryRegex(symbol);
    for (const [index, line] of text.split("\n").entries()) {
      const lineNumber = index + 1;
      if (skipLineNumbers.has(lineNumber)) continue;
      if (lineRegex.test(line)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function resolveCallers(
  owner: string,
  repo: string,
  symbol: string,
  headSha: string,
  token: string,
  skipPaths: Set<string> | null,
  additionalPaths: Iterable<string> = [],
  skipLineNumbersByPath: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  fetchImpl: typeof fetch,
  options: ScanOptions = {},
): Promise<string[]> {
  const hitPaths = await searchUsages(
    owner,
    repo,
    symbol,
    token,
    fetchImpl,
    options,
  );
  const candidatePaths = new Set(hitPaths);
  for (const path of additionalPaths) candidatePaths.add(path);
  const callers: string[] = [];
  for (const path of candidatePaths) {
    if (skipPaths?.has(path)) continue;
    if (callers.length >= MAX_CALLERS_PER_SYMBOL) break;
    if (
      await readFileContainsSymbol(
        owner,
        repo,
        path,
        symbol,
        headSha,
        token,
        fetchImpl,
        skipLineNumbersByPath.get(path) ?? new Set(),
        options,
      )
    ) {
      callers.push(path);
    }
  }
  return callers;
}

interface Candidate {
  kind: CallerImpactFinding["kind"];
  file: string;
  line: number;
  symbol: string;
  searchSymbol: string;
  previousSymbol?: string;
}

function collectCandidates(added: ParsedExport[], removed: ParsedExport[]): Candidate[] {
  const addedBySymbol = new Map<string, ParsedExport[]>();
  const removedBySymbol = new Map<string, ParsedExport[]>();
  const addedAliasByLocal = new Map<string, ParsedExport[]>();
  const removedAliasByLocal = new Map<string, ParsedExport[]>();

  for (const entry of added) {
    const list = addedBySymbol.get(entry.symbol) ?? [];
    list.push(entry);
    addedBySymbol.set(entry.symbol, list);
    if (entry.usesAlias) {
      const aliasList = addedAliasByLocal.get(entry.localSymbol) ?? [];
      aliasList.push(entry);
      addedAliasByLocal.set(entry.localSymbol, aliasList);
    }
  }
  for (const entry of removed) {
    const list = removedBySymbol.get(entry.symbol) ?? [];
    list.push(entry);
    removedBySymbol.set(entry.symbol, list);
    if (entry.usesAlias) {
      const aliasList = removedAliasByLocal.get(entry.localSymbol) ?? [];
      aliasList.push(entry);
      removedAliasByLocal.set(entry.localSymbol, aliasList);
    }
  }

  const candidates: Candidate[] = [];
  const renameFrom = new Set<string>();
  const renameTo = new Set<string>();

  for (const [local, removedAliasList] of removedAliasByLocal) {
    const addedAliasList = addedAliasByLocal.get(local) ?? [];
    if (removedAliasList.length !== 1 || addedAliasList.length !== 1) continue;
    const removedAlias = removedAliasList[0];
    const addedAlias = addedAliasList[0];
    if (!removedAlias || !addedAlias) continue;
    if (removedAlias.symbol === addedAlias.symbol) continue;

    candidates.push({
      kind: "renamed",
      file: removedAlias.file,
      line: removedAlias.line,
      symbol: addedAlias.symbol,
      searchSymbol: removedAlias.symbol,
      previousSymbol: removedAlias.symbol,
    });
    renameFrom.add(removedAlias.symbol);
    renameTo.add(addedAlias.symbol);
  }

  for (const [symbol, entries] of removedBySymbol) {
    if (!entries.length || renameFrom.has(symbol) || removedBySymbol.get(symbol)?.length === 0)
      continue;
    if (addedBySymbol.has(symbol)) continue;
    const first = entries[0];
    if (!first) continue;
    candidates.push({
      kind: "removed",
      file: first.file,
      line: first.line,
      symbol,
      searchSymbol: symbol,
    });
  }

  for (const [symbol, entries] of addedBySymbol) {
    if (!entries.length || renameTo.has(symbol)) continue;
    if (removedBySymbol.has(symbol)) {
      const first = entries[0];
      if (!first) continue;
      candidates.push({
        kind: "changed",
        file: first.file,
        line: first.line,
        symbol,
        searchSymbol: symbol,
      });
      continue;
    }
    const first = entries[0];
    if (!first) continue;
    candidates.push({
      kind: "dead",
      file: first.file,
      line: first.line,
      symbol,
      searchSymbol: symbol,
    });
  }

  const deduped = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.symbol}`;
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  return Array.from(deduped.values()).slice(0, MAX_SYMBOLS);
}

/** Analyzer entrypoint: return caller-impact and dead-symbol findings from diff exports + search-backed usage checks. */
export async function scanCallerImpact(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CallerImpactFinding[]> {
  if (!req.githubToken || !req.headSha) return [];
  const repo = parseRepo(req.repoFullName);
  if (!repo) return [];

  const files = req.files ?? [];
  const { added, removed, changedPaths } = collectFromPatch(files);
  if (!added.length && !removed.length) return [];

  const candidates = collectCandidates(added, removed);
  if (!candidates.length) return [];

  const findings: CallerImpactFinding[] = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) throw new Error("analyzer_aborted");
    const skipLineNumbersByPath =
      candidate.kind === "dead"
        ? new Map([[candidate.file, new Set([candidate.line])]])
        : new Map<string, Set<number>>();
    const isDead = candidate.kind === "dead";
    const skipPaths = isDead ? null : changedPaths;
    const additionalPaths = isDead ? Array.from(changedPaths) : [];
    const callers = await resolveCallers(
      repo.owner,
      repo.repo,
      candidate.searchSymbol,
      req.headSha,
      req.githubToken,
      skipPaths,
      additionalPaths,
      skipLineNumbersByPath,
      fetchImpl,
      options,
    );

    if (candidate.kind === "dead") {
      if (callers.length === 0) {
        findings.push({
          kind: "dead",
          file: candidate.file,
          line: candidate.line,
          symbol: candidate.symbol,
          callers: [],
        });
      }
      continue;
    }

    if (callers.length > 0) {
      findings.push({
        kind: candidate.kind,
        file: candidate.file,
        line: candidate.line,
        symbol: candidate.symbol,
        callers,
        previousSymbol: candidate.previousSymbol,
      });
    }
  }

  return findings;
}

// Cross-file caller-impact / dead-symbol analyzer (#1509). Surfaces two cross-file hazards the no-checkout
// `claude --print` reviewer (which only sees the diff) is blind to:
//   1. An exported top-level symbol the PR removes / renames / changes the signature of that STILL has live callers
//      in files the PR did NOT touch — a hidden compile/runtime break. Candidate callers come from the GitHub Code
//      Search API (text-match) on the default branch; each candidate's CONTENT is then fetched and a finding is only
//      reported when that file actually IMPORTS the symbol FROM the changed module — so a file that merely defines or
//      uses its own identically-named symbol is never falsely flagged.
//   2. A newly-exported symbol referenced nowhere in the PR — dead-on-arrival. Code Search indexes the DEFAULT branch
//      only, so a brand-new symbol is invisible to it; this is judged from the diff (the new export is dead if no
//      added CODE line — comments/strings excluded — outside its own declaration references it), and entrypoint files
//      (index.*, *.d.ts) are skipped because public API is intentionally unused internally.
//
// Export churn is read from the FULL patch (context + removed → pre-image; context + added → post-image) so a change
// confined to a parameter line of a multiline signature is still seen even when the `export …` line is unchanged
// context. Reports symbol names + unchanged caller file paths only — never source. Fail-safe: a failed / rate-limited
// lookup drops that symbol only; a candidate whose content can't be verified is dropped.
import type { EnrichRequest, CallerImpactFinding } from "../types.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_SYMBOLS_SEARCHED = 8; // Code Search is rate-limited (~10/min); bound the per-PR symbol fan-out
const MAX_DEAD_REPORTED = 10; // cap dead-on-arrival findings (diff-only, no network)
const MAX_CALLER_FILES = 10; // cap caller files listed per symbol
const MAX_CALLER_CANDIDATES = 20; // candidate code files (per symbol) to import-verify before stopping
const CODE_SEARCH_PER_PAGE = 20;
const MAX_SEARCH_PAGES = 5; // pages one symbol may walk (≤100 hits) to see past filtered noise on page 1
const MAX_TOTAL_SEARCH_REQUESTS = 10; // global Code Search request budget (respects the ~10/min secondary limit)
const MAX_TOTAL_CONTENT_FETCHES = 30; // global Contents-API budget for import verification across all symbols
const MAX_DECL_LINES = 40; // bound the contiguous multiline export declaration accumulated for signature comparison

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ENTRYPOINT_RE = /(^|\/)index\.[cm]?[jt]sx?$|\.d\.ts$/; // public-API files: skip dead-on-arrival here
// Only a code file can be a real "caller"; a match in a doc/markdown/text/config file is never a compile/runtime dep.
const CODE_FILE_RE = /\.(?:m?[jt]sx?|cts|mts|vue|svelte)$/i;
const MODULE_EXT_RE = /\.(?:d\.ts|[cm]?[jt]sx?|cts|mts|vue|svelte)$/i;

interface ScanOptions {
  signal?: AbortSignal;
}

/** Parse `owner/repo`, rejecting anything that isn't exactly two safe segments (no traversal / extra slashes) so a
 *  hostile `repoFullName` cannot redirect the token-bearing request elsewhere. Returns null when unsafe. */
export function parseRepo(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  for (const seg of [owner, repo]) {
    if (!seg || seg === "." || seg === ".." || !REPO_SEGMENT.test(seg)) {
      return null;
    }
  }
  return { owner: owner!, repo: repo! };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-identifier matcher for `symbol` — boundaries exclude identifier characters (incl. `$`). */
function identifier(symbol: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
}

/** The module basename used to match an import source to the changed file: last path segment without extension. */
export function moduleBasename(path: string): string {
  const seg = (path.split(/[\\/]/).pop() ?? "").trim();
  return seg.replace(MODULE_EXT_RE, "");
}

/** Split a comma-separated list at top level only (commas inside (), [], {} are ignored). */
function splitTopLevelCommas(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** Strip line/block comments and string/template-literal CONTENT from a single line, so a symbol that appears only in
 *  a comment or string is not mistaken for a real code reference. Best-effort single-line scrub (this analyzer is
 *  advisory): a comment-only line (`//…`, JSDoc `*…`, `/*…`) is dropped entirely. */
export function stripCommentsAndStrings(line: string): string {
  const trimmed = line.trim();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  ) {
    return "";
  }
  return line
    .replace(/\/\*.*?\*\//g, " ") // inline block comment
    .replace(/\/\/.*$/, " ") // trailing line comment
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted string content
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted string content
    .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // template-literal content
}

/** True when `symbol` appears as a real code reference (a whole identifier in non-comment, non-string code) somewhere
 *  in `code`. Used as a cheap PRE-FILTER over a Code Search fragment / a diff line — the authoritative caller check is
 *  import verification (`importsSymbolFromModule`); for the diff-only dead path this is the decision. */
export function referencesSymbol(code: string, symbol: string): boolean {
  const re = identifier(symbol);
  for (const rawLine of code.split("\n")) {
    if (re.test(stripCommentsAndStrings(rawLine))) return true;
  }
  return false;
}

/** True when `content` imports `symbol` from a module whose basename matches `moduleName` — i.e. a real consumer of
 *  the removed/changed export, not a file that merely defines or uses its OWN identically-named symbol. */
export function importsSymbolFromModule(
  content: string,
  symbol: string,
  moduleName: string,
): boolean {
  const idRe = identifier(symbol);
  const importRe = /import\s+(?:type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(importRe)) {
    const clause = match[1] ?? "";
    const source = match[2] ?? "";
    if (moduleBasename(source) !== moduleName) continue;
    if (idRe.test(clause)) return true;
  }
  return false;
}

/** Exported top-level identifier(s) declared by a single (possibly multiline-joined) export statement. Handles
 *  `export function|class|interface|type|enum|namespace NAME`, `export const enum NAME`, multi-declarator
 *  `export const a = 1, b = 2`, `export default function|class NAME`, and `export { a, b as c }` (the public name is
 *  the alias after `as`). Returns [] for `export * from …`, anonymous default exports, and non-export lines. */
export function parseExportedNames(line: string): string[] {
  const s = line.trim();
  if (!s.startsWith("export")) return [];

  const brace = s.match(/^export\s+(?:type\s+)?\{([^}]*)\}/);
  if (brace) {
    return brace[1]!
      .split(",")
      .map((part) => {
        const seg = part.trim();
        const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)/);
        if (asMatch) return asMatch[1]!;
        const id = seg.match(/^([A-Za-z_$][\w$]*)/);
        return id ? id[1]! : "";
      })
      .filter((name): name is string => name.length > 0 && name !== "default");
  }

  const def = s.match(
    /^export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/,
  );
  if (def) return [def[1]!];

  const constEnum = s.match(
    /^export\s+(?:declare\s+)?const\s+enum\s+([A-Za-z_$][\w$]*)/,
  );
  if (constEnum) return [constEnum[1]!];

  // `export const a = 1, b = 2` declares every top-level declarator, not only the first.
  const varDecl = s.match(
    /^export\s+(?:declare\s+)?(?:const|let|var)\s+(?!enum\b)([\s\S]+)$/,
  );
  if (varDecl) {
    const names: string[] = [];
    for (const part of splitTopLevelCommas(varDecl[1]!)) {
      const id = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (id) names.push(id[1]!);
    }
    return names;
  }

  const decl = s.match(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  );
  if (decl) return [decl[1]!];

  return [];
}

const norm = (line: string): string => line.trim().replace(/\s+/g, " ");

/** Inclusive index where the export declaration starting at `start` ends: walk lines until the bracket depth
 *  (parens/braces/brackets) returns to 0 and the line is not a continuation. This captures the FULL contiguous
 *  multiline declaration — function parameter lists, interface/object/type bodies, and `export { … }` blocks — so a
 *  signature change on a LATER line is not mistaken for an identical move/reformat. Bounded by MAX_DECL_LINES. */
function declarationEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length && i - start < MAX_DECL_LINES; i++) {
    for (const ch of lines[i]!) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    }
    // Complete when nothing is left open and the line does not end on a continuation operator (`=`, `|`, `&`, `,`, `(`, `<`).
    if (depth === 0 && !/[=|&,(<]\s*$/.test(lines[i]!)) return i;
  }
  return Math.min(start + MAX_DECL_LINES - 1, lines.length - 1);
}

/** Parse exported symbol names from a sequence of source lines. Each multiline export declaration is joined into one
 *  statement so the FULL declaration text (not just its first line) is compared for signature changes. Returns one
 *  entry per export statement. */
export function extractExports(
  lines: string[],
): Array<{ names: string[]; declText: string }> {
  const out: Array<{ names: string[]; declText: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim().startsWith("export")) continue;
    const end = declarationEnd(lines, i);
    const joined = norm(lines.slice(i, end + 1).join(" "));
    const names = parseExportedNames(joined);
    if (names.length) out.push({ names, declText: joined });
    i = end;
  }
  return out;
}

/** A unified-diff patch split into its pre-image (context + removed) and post-image (context + added), plus the
 *  purely-added lines. Comparing exports parsed from the pre- vs post-image catches a change confined to an inner line
 *  of a multiline declaration whose `export …` line is unchanged context. */
function splitPatchImages(patch: string): {
  pre: string[];
  post: string[];
  added: string[];
} {
  const pre: string[] = [];
  const post: string[] = [];
  const added: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      const text = line.slice(1);
      post.push(text);
      added.push(text);
    } else if (line.startsWith("-")) {
      pre.push(line.slice(1));
    } else {
      const ctx = line.startsWith(" ") ? line.slice(1) : line;
      pre.push(ctx);
      post.push(ctx);
    }
  }
  return { pre, post, added };
}

interface DiffExports {
  /** exported name → pre-image declaration text (context + removed lines) */
  oldExports: Map<string, string>;
  /** exported name → post-image declaration text (context + added lines) */
  newExports: Map<string, string>;
  /** old exported name → the file it was declared in */
  oldExportFile: Map<string, string>;
  /** new exported name → the file it was declared in */
  newExportFile: Map<string, string>;
  /** purely-added source lines across the PR (for the dead-on-arrival reference scan) */
  addedLines: string[];
}

/** Collect the PR's exported-symbol churn from every file patch, reconstructing each file's pre- and post-image. */
export function collectDiffExports(
  files: NonNullable<EnrichRequest["files"]>,
): DiffExports {
  const oldExports = new Map<string, string>();
  const newExports = new Map<string, string>();
  const oldExportFile = new Map<string, string>();
  const newExportFile = new Map<string, string>();
  const addedLines: string[] = [];

  for (const file of files) {
    if (!file.patch) continue;
    const { pre, post, added } = splitPatchImages(file.patch);
    for (const src of added) addedLines.push(src);
    for (const { names, declText } of extractExports(pre)) {
      for (const name of names) {
        oldExports.set(name, declText);
        if (!oldExportFile.has(name)) oldExportFile.set(name, file.path);
      }
    }
    for (const { names, declText } of extractExports(post)) {
      for (const name of names) {
        newExports.set(name, declText);
        if (!newExportFile.has(name)) newExportFile.set(name, file.path);
      }
    }
  }
  return { oldExports, newExports, oldExportFile, newExportFile, addedLines };
}

/** True when the symbol is used in an added line OTHER than its own export declaration (so it is NOT dead). A mention
 *  only in a comment or string is not a real reference. */
export function isReferencedInDiff(symbol: string, addedLines: string[]): boolean {
  const re = identifier(symbol);
  for (const line of addedLines) {
    if (parseExportedNames(line).includes(symbol)) continue; // the export/re-export declaration itself
    if (re.test(stripCommentsAndStrings(line))) return true;
  }
  return false;
}

/** Fetch a file's raw content from the default branch, or null on a non-OK reply / network error. */
async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  token: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const encodedPath = path
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
    const res = await fetchImpl(url, {
      headers: { ...githubHeaders(token), Accept: "application/vnd.github.raw" },
      signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Candidate unchanged CODE files (outside `changed`) whose matched fragment references `symbol`, walking Code Search
 *  pages past filtered noise. Returns null on a non-OK reply / network error (drops this symbol only). */
async function searchCallerCandidates(
  symbol: string,
  owner: string,
  repo: string,
  changed: Set<string>,
  token: string,
  fetchImpl: typeof fetch,
  budget: { remaining: number },
  signal?: AbortSignal,
): Promise<string[] | null> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const query = `"${symbol}" repo:${owner}/${repo}`;
  for (let page = 1; page <= MAX_SEARCH_PAGES && budget.remaining > 0; page++) {
    budget.remaining--;
    let json: {
      total_count?: number;
      items?: Array<{ path?: string; text_matches?: Array<{ fragment?: string }> }>;
    };
    try {
      const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(query)}&per_page=${CODE_SEARCH_PER_PAGE}&page=${page}`;
      // text-match media type returns the matched fragments, so a hit can be pre-filtered to real references rather
      // than doc/comment/string mentions (Code Search itself is a plain text search).
      const res = await fetchImpl(url, {
        headers: { ...githubHeaders(token), Accept: "application/vnd.github.text-match+json" },
        signal,
      });
      if (!res.ok) return null;
      json = (await res.json()) as typeof json;
    } catch {
      return null;
    }
    const items = json.items ?? [];
    for (const item of items) {
      const path = item.path;
      if (typeof path !== "string" || changed.has(path) || !CODE_FILE_RE.test(path) || seen.has(path)) {
        continue;
      }
      if ((item.text_matches ?? []).some((m) => referencesSymbol(m.fragment ?? "", symbol))) {
        seen.add(path);
        candidates.push(path);
        if (candidates.length >= MAX_CALLER_CANDIDATES) return candidates;
      }
    }
    if (items.length < CODE_SEARCH_PER_PAGE) break; // last page
    if (typeof json.total_count === "number" && page * CODE_SEARCH_PER_PAGE >= json.total_count) break;
  }
  return candidates;
}

/** Unchanged files that IMPORT `symbol` from `moduleName` (the changed module). Code Search surfaces candidates by
 *  text; each candidate's content is then fetched and import-verified so a same-named symbol in an unrelated module is
 *  never reported. Returns null only when the Code Search itself failed (drops this symbol). */
async function findExternalCallers(
  symbol: string,
  owner: string,
  repo: string,
  changed: Set<string>,
  moduleName: string,
  token: string,
  fetchImpl: typeof fetch,
  searchBudget: { remaining: number },
  contentBudget: { remaining: number },
  signal?: AbortSignal,
): Promise<string[] | null> {
  const candidates = await searchCallerCandidates(symbol, owner, repo, changed, token, fetchImpl, searchBudget, signal);
  if (candidates === null) return null;
  const callers: string[] = [];
  for (const path of candidates) {
    if (callers.length >= MAX_CALLER_FILES || contentBudget.remaining <= 0) break;
    contentBudget.remaining--;
    const content = await fetchFileContent(owner, repo, path, token, fetchImpl, signal);
    if (content === null) continue; // can't verify the import → drop (conservative)
    if (importsSymbolFromModule(content, symbol, moduleName)) callers.push(path);
  }
  return callers.sort();
}

/** Analyzer entrypoint. Flags removed/renamed/changed exports that still have importing callers in unchanged files,
 *  plus dead-on-arrival new exports. The caller path needs a token (skipped without one); the diff-only dead-on-arrival
 *  path runs regardless. Fail-safe: returns [] without a repo or export churn; a failed lookup drops that symbol only. */
export async function scanCallerImpact(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CallerImpactFinding[]> {
  const token = req.githubToken;
  const repo = parseRepo(req.repoFullName);
  const files = req.files ?? [];
  if (!repo || files.length === 0) return [];

  const { oldExports, newExports, oldExportFile, newExportFile, addedLines } = collectDiffExports(files);
  if (oldExports.size === 0 && newExports.size === 0) return [];

  const changed = new Set<string>();
  for (const file of files) {
    changed.add(file.path);
    if (file.previousPath) changed.add(file.previousPath);
  }

  const findings: CallerImpactFinding[] = [];

  // Removed / renamed / signature-changed exports → importing callers in unchanged files. Needs the token; skipped
  // without one. Bounded by the shared Code Search + Contents budgets.
  if (token) {
    const searchBudget = { remaining: MAX_TOTAL_SEARCH_REQUESTS };
    const contentBudget = { remaining: MAX_TOTAL_CONTENT_FETCHES };
    let searched = 0;
    for (const [symbol, oldText] of oldExports) {
      if (searched >= MAX_SYMBOLS_SEARCHED || searchBudget.remaining <= 0) break;
      const newText = newExports.get(symbol);
      if (newText !== undefined && newText === oldText) continue; // unchanged ⇒ skip
      const moduleName = moduleBasename(oldExportFile.get(symbol) ?? "");
      if (!moduleName) continue;
      searched++;
      const callerFiles = await findExternalCallers(symbol, repo.owner, repo.repo, changed, moduleName, token, fetchImpl, searchBudget, contentBudget, options.signal);
      if (!callerFiles || callerFiles.length === 0) continue;
      findings.push({
        symbol,
        kind: newText === undefined ? "removed-with-callers" : "changed-with-callers",
        callerFiles,
      });
    }
  }

  // Dead-on-arrival: newly-exported symbols (not also present before) referenced nowhere in the diff. Diff-only — Code
  // Search can't see a brand-new symbol. Skip public-entrypoint files, whose exports are meant for external use.
  let deadReported = 0;
  for (const [symbol] of newExports) {
    if (deadReported >= MAX_DEAD_REPORTED) break;
    if (oldExports.has(symbol)) continue; // changed, not new — handled above
    const file = newExportFile.get(symbol) ?? "";
    if (ENTRYPOINT_RE.test(file)) continue; // likely public API
    if (isReferencedInDiff(symbol, addedLines)) continue;
    deadReported++;
    findings.push({ symbol, kind: "dead-on-arrival", callerFiles: [] });
  }

  // Stable order (by kind, then symbol) so the rendered brief is deterministic regardless of Code Search result order.
  return findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.symbol.localeCompare(b.symbol));
}

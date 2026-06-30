// Cross-file caller-impact / dead-symbol analyzer (#1509). Surfaces two cross-file hazards the no-checkout
// `claude --print` reviewer (which only sees the diff) is blind to:
//   1. An exported top-level symbol the PR REMOVES or RENAMES AWAY from a module while it still has importing
//      dependents in files the PR did NOT touch — a hidden compile/runtime break. Candidate dependents come from the
//      GitHub Code Search API (text-match) on the default branch; each candidate's CONTENT is then fetched and a
//      finding is only reported when that file actually DEPENDS ON the symbol FROM the changed module — a named
//      import, a namespace import used as `ns.symbol`, an `export { symbol } from`, or an `export * from` barrel —
//      where the import specifier RESOLVES (relative to the candidate file) to the changed file's path. So a
//      same-named export in an unrelated module, or an import of a different `./lib`, is never falsely flagged.
//      Churn is keyed per (file, name) using each file's OLD path (so a rename is seen), and only the PRESENCE of an
//      export is considered — an in-place signature/body edit is deliberately NOT flagged (a body change doesn't
//      break importers and signature-vs-body can't be told apart reliably from a diff). Default exports are not
//      modeled (a consumer imports a default with any local name, which name-based Code Search can't resolve).
//   2. A newly-exported symbol referenced nowhere in the PR — dead-on-arrival. Code Search indexes the DEFAULT branch
//      only, so a brand-new symbol is invisible to it; this is judged from the diff, and entrypoint files
//      (index.*, *.d.ts) are skipped because public API is intentionally unused internally.
//
// Reports symbol names + unchanged dependent file paths only — never source. The caller path uses the request's
// short-lived githubToken; the diff-only dead-on-arrival path needs neither token nor network. Fail-safe: a failed /
// rate-limited lookup drops that symbol only; a candidate whose content/import can't be verified is dropped.
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
const MAX_DECL_LINES = 40; // bound the contiguous multiline export declaration accumulated for name extraction

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ENTRYPOINT_RE = /(^|\/)index\.[cm]?[jt]sx?$|\.d\.ts$/; // public-API files: skip dead-on-arrival here
// Only a code file can be a real dependent; a match in a doc/markdown/text/config file is never a compile/runtime dep.
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

/** Canonical comparable module path: forward slashes, no file extension, no trailing `/index`. */
export function normalizeModulePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(MODULE_EXT_RE, "")
    .replace(/\/index$/, "");
}

/** Resolve a relative import specifier against the importing file's path -> a normalized module path. Returns null for
 *  a non-relative (bare package / tsconfig-alias) specifier that can't be resolved without build config. */
export function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const stack = fromFile.replace(/\\/g, "/").split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return normalizeModulePath(stack.join("/"));
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
 *  a comment or string is not mistaken for a real code reference. Best-effort single-line scrub (advisory): a
 *  comment-only line (`//...`, JSDoc `*...`, `/*...`) is dropped entirely. */
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

/** True when the candidate file `content` (at `candidatePath`) depends on `symbol` from the changed module at
 *  `changedPath`. A dependent is: a named import / re-export `{ ... symbol ... } from`, a namespace import
 *  `* as ns from` used as `ns.symbol`, or an `export * from` barrel — in every case the specifier must RESOLVE
 *  (relative to the candidate file) to the changed file's path, so a same-named export in an unrelated module, or an
 *  import of a different `./lib`, is not matched. */
export function importsSymbolFromModule(
  content: string,
  symbol: string,
  candidatePath: string,
  changedPath: string,
): boolean {
  const target = normalizeModulePath(changedPath);
  const idRe = identifier(symbol);
  const clauseRe =
    /\b(?:import|export)\s+(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+([A-Za-z_$][\w$]*))?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(clauseRe)) {
    const clause = match[1] ?? "";
    const namespaceAlias = match[2];
    const specifier = match[3] ?? "";
    if (resolveImport(candidatePath, specifier) !== target) continue;
    if (clause.startsWith("{")) {
      if (idRe.test(clause)) return true; // named import or `export { symbol } from`
    } else if (namespaceAlias) {
      // `import * as ns from <module>` is a dependent only if it actually uses `ns.symbol`.
      const usage = new RegExp(
        `(?<![\\w$])${escapeRegExp(namespaceAlias)}\\s*\\.\\s*${escapeRegExp(symbol)}(?![\\w$])`,
      );
      if (usage.test(content)) return true;
    } else {
      return true; // `export * from <module>` barrel re-exports every symbol, incl. this one
    }
  }
  return false;
}

/** Exported top-level identifier(s) declared by a single (possibly multiline-joined) export statement. Handles
 *  `export function|class|interface|type|enum|namespace NAME`, `export const enum NAME`, multi-declarator
 *  `export const a = 1, b = 2`, and `export { a, b as c }` (the public name is the alias after `as`). Returns [] for
 *  `export default ...` (defaults aren't modeled), `export * from ...`, and non-export lines. */
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

  // Default exports are intentionally NOT modeled: an unchanged consumer imports a default with any local name
  // (`import anything from './lib'`), which name-based Code Search can't resolve, so treating the declared name
  // (`export default function main`) as the public symbol would be wrong. (#1509)
  if (/^export\s+default\b/.test(s)) return [];

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
 *  (parens/braces/brackets) returns to 0 and the line is not a continuation. Captures the FULL contiguous multiline
 *  declaration so a name on a later line is still parsed. Bounded by MAX_DECL_LINES. */
function declarationEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length && i - start < MAX_DECL_LINES; i++) {
    for (const ch of lines[i]!) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && !/[=|&,(<]\s*$/.test(lines[i]!)) return i;
  }
  return Math.min(start + MAX_DECL_LINES - 1, lines.length - 1);
}

/** Parse exported symbol names from a sequence of source lines. Each multiline export declaration is joined into one
 *  statement so a name spread across several lines is still found. */
export function extractExports(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim().startsWith("export")) continue;
    const end = declarationEnd(lines, i);
    const joined = norm(lines.slice(i, end + 1).join(" "));
    out.push(...parseExportedNames(joined));
    i = end;
  }
  return out;
}

/** A unified-diff patch split into its pre-image (context + removed) and post-image (context + added), plus the
 *  purely-added lines. Reconstructing each image catches a churn confined to an inner line of a declaration whose
 *  `export ...` line is unchanged context. */
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
  /** set of `${file} ${name}` exported in some file's pre-image (file = the file's OLD path, so a rename is seen) */
  oldExports: Set<string>;
  /** set of `${file} ${name}` exported in some file's post-image */
  newExports: Set<string>;
  /** old export `${file} ${name}` -> { file (old path), name }, for caller resolution against the old module */
  oldExportInfo: Map<string, { file: string; name: string }>;
  /** the set of names exported anywhere before the PR (so a genuinely-new name can be told from a move) */
  oldNames: Set<string>;
  /** newly-exported name -> the file it was first declared in (for the dead-on-arrival entrypoint check) */
  newExportFile: Map<string, string>;
  /** the set of names exported anywhere in the post-image (dead-on-arrival iterates these) */
  newNames: Set<string>;
  /** purely-added source lines across the PR (for the dead-on-arrival reference scan) */
  addedLines: string[];
}

/** Collect the PR's exported-symbol churn PER FILE, reconstructing each file's pre- and post-image. */
export function collectDiffExports(
  files: NonNullable<EnrichRequest["files"]>,
): DiffExports {
  const oldExports = new Set<string>();
  const newExports = new Set<string>();
  const oldExportInfo = new Map<string, { file: string; name: string }>();
  const oldNames = new Set<string>();
  const newExportFile = new Map<string, string>();
  const newNames = new Set<string>();
  const addedLines: string[] = [];

  for (const file of files) {
    if (!file.patch) continue;
    const { pre, post, added } = splitPatchImages(file.patch);
    for (const src of added) addedLines.push(src);
    // Pre-image exports belong to the file's OLD path, so a pure rename (src/old.ts -> src/new.ts) makes the export
    // "removed" from src/old.ts and importers of `./old` are correctly flagged. (#1509)
    const oldPath = file.previousPath ?? file.path;
    for (const name of extractExports(pre)) {
      const key = `${oldPath} ${name}`;
      oldExports.add(key);
      oldExportInfo.set(key, { file: oldPath, name });
      oldNames.add(name);
    }
    for (const name of extractExports(post)) {
      newExports.add(`${file.path} ${name}`);
      newNames.add(name);
      if (!newExportFile.has(name)) newExportFile.set(name, file.path);
    }
  }
  return { oldExports, newExports, oldExportInfo, oldNames, newExportFile, newNames, addedLines };
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

/** Unchanged files that DEPEND ON `symbol` from the changed module at `changedPath`. Code Search surfaces candidates
 *  by text; each candidate's content is then fetched and import-verified (relative-path resolved) so a same-named
 *  symbol in an unrelated module is never reported. Returns null only when the Code Search itself failed. */
async function findExternalCallers(
  symbol: string,
  owner: string,
  repo: string,
  changed: Set<string>,
  changedPath: string,
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
    if (content === null) continue; // can't verify the import -> drop (conservative)
    if (importsSymbolFromModule(content, symbol, path, changedPath)) callers.push(path);
  }
  return callers.sort();
}

/** Analyzer entrypoint. Flags exports the PR removes / renames away that still have importing dependents in unchanged
 *  files, plus dead-on-arrival new exports. The caller path needs a token (skipped without one); the diff-only
 *  dead-on-arrival path runs regardless. Fail-safe: returns [] without a repo or export churn; a failed lookup drops
 *  that symbol only. */
export async function scanCallerImpact(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CallerImpactFinding[]> {
  const token = req.githubToken;
  const repo = parseRepo(req.repoFullName);
  const files = req.files ?? [];
  if (!repo || files.length === 0) return [];

  const { oldExports, newExports, oldExportInfo, oldNames, newExportFile, newNames, addedLines } =
    collectDiffExports(files);
  if (oldExports.size === 0 && newExports.size === 0) return [];

  const changed = new Set<string>();
  for (const file of files) {
    changed.add(file.path);
    if (file.previousPath) changed.add(file.previousPath);
  }

  const findings: CallerImpactFinding[] = [];

  // Removed / renamed-away exports -> importing dependents in unchanged files. An export is "removed from its module"
  // when its `${oldPath} ${name}` key is absent from the post-image set; an in-place signature/body change keeps the
  // key present and is intentionally NOT flagged. Needs the token; bounded by the shared Code Search + Contents budgets.
  if (token) {
    const searchBudget = { remaining: MAX_TOTAL_SEARCH_REQUESTS };
    const contentBudget = { remaining: MAX_TOTAL_CONTENT_FETCHES };
    let searched = 0;
    for (const key of oldExports) {
      if (searched >= MAX_SYMBOLS_SEARCHED || searchBudget.remaining <= 0) break;
      if (newExports.has(key)) continue; // still exported from this module
      const info = oldExportInfo.get(key);
      if (!info) continue;
      searched++;
      const callerFiles = await findExternalCallers(info.name, repo.owner, repo.repo, changed, info.file, token, fetchImpl, searchBudget, contentBudget, options.signal);
      if (!callerFiles || callerFiles.length === 0) continue;
      findings.push({ symbol: info.name, kind: "removed-with-callers", callerFiles });
    }
  }

  // Dead-on-arrival: genuinely-new exported symbols (not exported anywhere before) referenced nowhere in the diff.
  // Diff-only — Code Search can't see a brand-new symbol. Skip public-entrypoint files (exports meant for external use).
  let deadReported = 0;
  for (const name of newNames) {
    if (deadReported >= MAX_DEAD_REPORTED) break;
    if (oldNames.has(name)) continue; // existed before — a move, not a new export
    const file = newExportFile.get(name) ?? "";
    if (ENTRYPOINT_RE.test(file)) continue; // likely public API
    if (isReferencedInDiff(name, addedLines)) continue;
    deadReported++;
    findings.push({ symbol: name, kind: "dead-on-arrival", callerFiles: [] });
  }

  // Stable order (by kind, then symbol) so the rendered brief is deterministic regardless of Code Search result order.
  return findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.symbol.localeCompare(b.symbol));
}

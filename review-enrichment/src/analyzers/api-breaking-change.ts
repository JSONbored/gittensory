// Exported-API breaking-change detector (#1510). Flags a PR that REMOVES or SIGNATURE-CHANGES an exported symbol from
// a package's public TypeScript entrypoint (`index.*` barrel or a `.d.ts` surface) when that symbol is still part of
// the package's CURRENTLY-PUBLISHED type surface — i.e. a downstream break for consumers on the latest npm release.
// It reads removed/added export declarations from the diff, resolves the owning package.json at headSha (one authed
// contents fetch, walking up to the nearest ancestor manifest), then fetches the latest published `.d.ts` from npm +
// unpkg to confirm the symbol is public today. Deliberately conservative + fail-safe: a missing token/head-sha, an
// unresolvable repo slug or package, or any fetch error yields no finding rather than an error. A symbol removed AND
// re-added with an identical declaration is NOT a break; re-added with a changed declaration body is a signature change.
import type { ApiBreakingChangeFinding, EnrichRequest } from "../types.js";
import { isDiffFileHeaderLine } from "./diff-lines.js";
import { exportedSymbols } from "./undocumented-export.js";

const GITHUB_API = "https://api.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org";
const UNPKG = "https://unpkg.com";
const MAX_FILES = 10;
const MAX_FINDINGS = 30;
const MAX_FETCH_BYTES = 1_000_000;
// How many ancestor directories above the entrypoint's own directory to probe for the owning package.json.
const MAX_PACKAGE_ANCESTORS = 3;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
// A public TypeScript entrypoint: an `index.<ts/tsx/mts/cts>` barrel, or any declaration (`.d.ts`) surface. JS
// entrypoints are excluded — this scan is about the TYPED public surface a `.d.ts` consumer sees.
const ENTRYPOINT_RE = /(?:(?:^|\/)index\.(?:ts|tsx|mts|cts)$|\.d\.ts$)/;
// Test, generated, vendored, and minified output are not the hand-authored public surface. (Unlike the sibling
// undocumented-export scan, `.d.ts` is NOT skipped here — a published declaration file IS the entrypoint.)
const SKIP_RE = /(?:\.min\.|\.test\.|\.spec\.|__tests__\/|(?:^|\/)(?:dist|build|vendor)\/)/;
// A publishable npm package name (unscoped or `@scope/name`). Anything else can't be a real registry lookup → skip.
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

interface ScanOptions {
  signal?: AbortSignal;
}

/** Removed export declarations in a unified diff, each exported symbol with its OLD-file line number. Mirrors
 *  `parseAddedExports` but for `-` lines, walking hunk headers to track the OLD-file cursor; only `-` lines that
 *  declare a direct export are collected (`+`/`\` lines never advance the old cursor, `---`/`+++` headers are
 *  ignored). A multi-declarator line yields one entry per binding, all sharing the same line. Pure. */
export function parseRemovedExports(patch: string): Array<{ symbol: string; oldLine: number }> {
  const out: Array<{ symbol: string; oldLine: number }> = [];
  let oldLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      continue;
    }
    if (raw.startsWith("-")) {
      // Skip only a real unified-diff file header (`--- a/path`), not removed CONTENT that merely starts with
      // `--` (git renders `--x;` as `---x;`); mirror the added-side guard so removed exports aren't mis-numbered.
      if (!isDiffFileHeaderLine(raw)) {
        for (const symbol of exportedSymbols(raw.slice(1))) out.push({ symbol, oldLine });
        oldLine += 1;
      }
    } else if (!raw.startsWith("+") && !raw.startsWith("\\")) {
      oldLine += 1; // context line advances the old-file cursor
    }
  }
  return out;
}

/** Map each exported symbol to the trimmed body of the FIRST `prefix`-line (`+` or `-`) that declares it — used to
 *  compare a removed-and-readded symbol's old vs new declaration and decide whether its signature changed. Pure. */
function declarationBodies(patch: string, prefix: "+" | "-"): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@") || !raw.startsWith(prefix) || isDiffFileHeaderLine(raw)) continue;
    const body = raw.slice(1);
    for (const symbol of exportedSymbols(body)) {
      if (!map.has(symbol)) map.set(symbol, body.trim());
    }
  }
  return map;
}

/** Added export declarations in a unified diff — the SET of symbol names added on `+` lines. A local, allocation-
 *  cheap mirror of the added-symbol half of `parseAddedExports` (we need only the names, not line numbers). Pure. */
function addedExportSet(patch: string): Set<string> {
  const set = new Set<string>();
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@") || !raw.startsWith("+") || isDiffFileHeaderLine(raw)) continue;
    for (const symbol of exportedSymbols(raw.slice(1))) set.add(symbol);
  }
  return set;
}

async function readBoundedText(resp: Response, signal?: AbortSignal): Promise<string | null> {
  const length = Number(resp.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_FETCH_BYTES) return null;
  if (!resp.body) return null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FETCH_BYTES) {
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

/** The directory of `path`, then up to `MAX_PACKAGE_ANCESTORS` parent directories, from nearest to farthest — the
 *  ordered set of directories to probe for the entrypoint's owning `package.json`. Repo root is the empty string. */
function ancestorDirs(path: string): string[] {
  const slash = path.lastIndexOf("/");
  let dir = slash === -1 ? "" : path.slice(0, slash);
  const dirs: string[] = [];
  for (let i = 0; i <= MAX_PACKAGE_ANCESTORS; i++) {
    dirs.push(dir);
    if (dir === "") break;
    const idx = dir.lastIndexOf("/");
    dir = idx === -1 ? "" : dir.slice(0, idx);
  }
  return dirs;
}

/** Encode each path segment individually so an in-repo path with spaces/unicode still forms a valid URL while the
 *  `/` separators are preserved (the sibling undocumented-export analyzer builds contents URLs the same way). */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

interface ResolvedPackage {
  name: string;
  /** The `types`/`typings` entry from the repo package.json, or the `index.d.ts` default. */
  types: string;
}

/** Analyzer entrypoint: for each changed public entrypoint that REMOVES or signature-changes an export, resolve the
 *  owning package and confirm the symbol is still in the CURRENTLY-PUBLISHED type surface. Fail-safe — returns no
 *  finding on a missing token/head-sha, bad slug, unresolvable package, or any fetch error. */
export async function scanApiBreakingChange(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<ApiBreakingChangeFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  // Require EXACTLY `owner/repo`: a 3+ segment value would otherwise query the wrong repo instead of failing safe.
  const parts = repoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const ghHeaders: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Classify removed/signature-changed symbols per candidate entrypoint FIRST (cheap, pure), so the fetch budget is
  // spent only on entrypoints that actually have breaking changes.
  const candidates: Array<{
    file: (typeof files)[number];
    changed: Array<{ symbol: string; change: ApiBreakingChangeFinding["change"] }>;
  }> = [];
  for (const file of files) {
    if (!file.patch || !ENTRYPOINT_RE.test(file.path) || SKIP_RE.test(file.path)) continue;
    const removed = parseRemovedExports(file.patch);
    if (!removed.length) continue;
    const added = addedExportSet(file.patch);
    const removedBodies = declarationBodies(file.patch, "-");
    const addedBodies = declarationBodies(file.patch, "+");
    const changed: Array<{ symbol: string; change: ApiBreakingChangeFinding["change"] }> = [];
    const seen = new Set<string>();
    for (const { symbol } of removed) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      if (!added.has(symbol)) {
        changed.push({ symbol, change: "removed" });
      } else {
        // Removed AND re-added: an identical declaration is NOT a break; a changed declaration body is a signature
        // change. Fall through silently when either body is missing (can't confirm a change) — conservative.
        const before = removedBodies.get(symbol);
        const after = addedBodies.get(symbol);
        if (before !== undefined && after !== undefined && before !== after) {
          changed.push({ symbol, change: "signature-changed" });
        }
      }
    }
    if (!changed.length) continue;
    candidates.push({ file, changed });
    if (candidates.length >= MAX_FILES) break;
  }

  const findings: ApiBreakingChangeFinding[] = [];
  for (const { file, changed } of candidates) {
    if (options.signal?.aborted) break;

    const pkg = await resolvePackage(file.path, owner, repo, headSha, ghHeaders, fetchFn, options.signal);
    if (!pkg) continue;
    if (options.signal?.aborted) break;

    const published = await fetchPublishedSurface(pkg, fetchFn, options.signal);
    if (!published) continue;
    if (options.signal?.aborted) break;

    for (const { symbol, change } of changed) {
      if (!published.exports.has(symbol)) continue;
      findings.push({
        file: file.path,
        symbol,
        change,
        packageName: pkg.name,
        publishedVersion: published.version,
      });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

/** Walk the entrypoint path upward and return the first ancestor `package.json` (at headSha) that parses and has a
 *  string `name`. One authed GitHub contents fetch per ancestor; a fetch error or a nameless manifest is skipped. */
async function resolvePackage(
  entrypointPath: string,
  owner: string,
  repo: string,
  headSha: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<ResolvedPackage | null> {
  for (const dir of ancestorDirs(entrypointPath)) {
    if (signal?.aborted) return null;
    const manifestPath = dir ? `${dir}/package.json` : "package.json";
    let text: string | null = null;
    try {
      const resp = await fetchFn(
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(manifestPath)}?ref=${encodeURIComponent(headSha)}`,
        { headers, signal },
      );
      if (resp.ok) text = await readBoundedText(resp, signal);
    } catch {
      text = null;
    }
    if (!text) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (!json || typeof json !== "object") continue;
    const record = json as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) continue;
    const types =
      typeof record.types === "string"
        ? record.types
        : typeof record.typings === "string"
          ? record.typings
          : "index.d.ts";
    return { name: record.name, types };
  }
  return null;
}

interface PublishedSurface {
  version: string;
  exports: Set<string>;
}

/** Fetch the package's CURRENTLY-PUBLISHED type surface: the latest npm version + its declaration file's exported
 *  symbol names (from unpkg). Any fetch/parse failure returns null (the entrypoint is then skipped — no finding). */
async function fetchPublishedSurface(
  pkg: ResolvedPackage,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<PublishedSurface | null> {
  if (!PACKAGE_NAME_RE.test(pkg.name)) return null;
  const encodedName = encodePath(pkg.name);

  // 1. The latest published version + its declared types path (falling back to the repo manifest's, then the default).
  let latest: Record<string, unknown> | null = null;
  try {
    const resp = await fetchFn(`${NPM_REGISTRY}/${encodedName}/latest`, { signal });
    if (resp.ok) {
      const text = await readBoundedText(resp, signal);
      if (text) latest = JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    latest = null;
  }
  if (!latest || typeof latest.version !== "string" || !latest.version) return null;
  const version = latest.version;
  const typesPath =
    typeof latest.types === "string"
      ? latest.types
      : typeof latest.typings === "string"
        ? latest.typings
        : pkg.types || "index.d.ts";

  // 2. The published declaration file's raw text (bounded), from unpkg pinned to the resolved version.
  let dts: string | null = null;
  try {
    const resp = await fetchFn(`${UNPKG}/${encodedName}@${encodeURIComponent(version)}/${encodePath(typesPath)}`, {
      signal,
    });
    if (resp.ok) dts = await readBoundedText(resp, signal);
  } catch {
    dts = null;
  }
  if (!dts) return null;

  const exports = new Set<string>();
  for (const line of dts.split("\n")) {
    for (const symbol of exportedSymbols(line)) exports.add(symbol);
  }
  return { version, exports };
}

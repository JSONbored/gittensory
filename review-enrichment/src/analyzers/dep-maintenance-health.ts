// Package maintenance-health / deprecated-dep analyzer (#1511). For each dependency a PR newly ADDS or UPGRADES,
// flags the ones a maintainer would want to know about but the no-checkout reviewer cannot derive: a package that
// is DEPRECATED/yanked, or STALE (no release in roughly N years). Two deterministic registry signals only — no
// flaky "archived"/sole-maintainer/Scorecard probes. Reports package@version + a short factual reason.
//   - npm: the packument `deprecated` field (non-empty string ⇒ deprecated, surface a short reason) and the `time`
//     map (the newest version's publish date — stale when the most recent publish is older than the threshold).
//   - PyPI: the PROJECT-level JSON `releases` map. The queried version is matched to its actual release key by
//     PEP 440 equality (a `==1.0.0` requirement can be published as `1.0`); yanked when that release's files are
//     all yanked, otherwise stale when the newest upload across all releases is older than the threshold.
import type { EnrichRequest, DepMaintenanceHealthFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const MAX_QUERIES = 25;
// Staleness threshold: flag a package whose most recent release is older than this. Two years in ms.
const STALE_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;
// Cap the registry body we read so an oversized packument/project JSON fails closed instead of blowing the budget.
const MAX_REGISTRY_JSON_BYTES = 2 * 1024 * 1024;

const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PYPI_PACKAGE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// PyPI versions are PEP 440, not semver: `1.0`, `24.1`, `1.0rc1`, `1.0.post1`, `1!2.0`. Validate only that the
// string is non-empty and URL-path-safe (it goes into the project JSON URL) rather than imposing semver.
const PYPI_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,63}$/;

/** Is this dependency change one we can query a registry for (supported ecosystem + URL-safe name/version)? */
function isQueryable(change: { ecosystem: string; package: string; to: string }): boolean {
  if (change.ecosystem === "npm") return NPM_PACKAGE_RE.test(change.package) && SEMVER_RE.test(change.to);
  if (change.ecosystem === "PyPI") return PYPI_PACKAGE_RE.test(change.package) && PYPI_VERSION_RE.test(change.to);
  return false;
}

interface ScanLimits {
  maxQueries?: number;
  staleAgeMs?: number;
}

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
}

/** A maintenance signal derived from registry metadata: `deprecated`/`yanked`, or `stale`. */
type Health = { kind: "deprecated" | "yanked" | "stale"; reason: string };

/** Collapse whitespace and cap the length of a registry-supplied reason so the rendered line stays short + safe. */
function tidyReason(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Pure: the most recent publish date (ms epoch) from an npm `time` map, ignoring the `created`/`modified`
 *  pseudo-entries and any unparseable timestamp. Returns null when no real, parseable publish date exists. */
export function newestNpmPublishMs(time: Record<string, string> | undefined): number | null {
  if (!time) return null;
  let newest: number | null = null;
  for (const [version, iso] of Object.entries(time)) {
    if (version === "created" || version === "modified") continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue; // garbage timestamp → ignore this entry (fail safe, don't flag)
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}

/** npm packument subset that carries the maintenance signals. `deprecated` is a string (the reason) when set, but
 *  registries have historically also emitted `true`/`false` — both non-string forms are handled defensively. */
export interface NpmPackument {
  deprecated?: unknown;
  versions?: Record<string, { deprecated?: unknown } | undefined>;
  time?: Record<string, string>;
}

/** Pure: classify an npm package from its packument for the QUERIED version. npm exposes deprecation per version
 *  under `versions[<version>].deprecated` (the reason string); a top-level `deprecated` is also accepted as a
 *  fallback. Otherwise stale when the newest real publish is older than `staleAgeMs`. `now` injected for tests. */
export function npmHealth(
  meta: NpmPackument,
  version: string,
  staleAgeMs: number,
  now: number,
): Health | null {
  // Deprecation lives on the queried version first, then the top level; a boolean/empty/whitespace value is NOT
  // a deprecation (fail safe). Only a non-empty reason string flags.
  const versionDeprecated = meta.versions?.[version]?.deprecated;
  const deprecatedReason =
    typeof versionDeprecated === "string" && versionDeprecated.trim() !== ""
      ? versionDeprecated
      : typeof meta.deprecated === "string" && meta.deprecated.trim() !== ""
        ? meta.deprecated
        : null;
  if (deprecatedReason !== null) {
    return { kind: "deprecated", reason: `deprecated by maintainer — ${tidyReason(deprecatedReason)}` };
  }
  const newest = newestNpmPublishMs(meta.time);
  if (newest !== null && now - newest > staleAgeMs) {
    const years = Math.floor((now - newest) / (365 * 24 * 60 * 60 * 1000));
    return { kind: "stale", reason: `no release in ~${years}y (last publish ${new Date(newest).toISOString().slice(0, 10)})` };
  }
  return null;
}

/** PyPI PROJECT-level JSON subset (`/pypi/<project>/json`): the all-release `releases` map. Each version maps to
 *  its uploaded files; each file carries its upload date and a per-file `yanked` flag/reason. The project endpoint
 *  is used (not the version-specific one) so staleness sees the whole release history and yanked is read per file. */
export interface PypiProjectJson {
  releases?: Record<
    string,
    Array<{
      upload_time_iso_8601?: string;
      upload_time?: string;
      yanked?: boolean;
      yanked_reason?: string | null;
    }>
  >;
}

// Bounded PEP 440 public-version grammar (epoch, release, then optional pre/post/dev in that order, optional local).
// Anchored, so arbitrary suffix text (e.g. `1.0foo`) fails to match — an invalid version can never collide with a
// real release key. Groups: 1 epoch, 2 release, 3 pre-letter, 4 pre-num, 5 dash-post-num, 6 post-letter,
// 7 post-num, 8 dev-presence, 9 dev-num.
const PEP440_RE =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?([-_.]?dev[-_.]?(\d+)?)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/;

/** Pure: a PEP 440 equality key for a version, or null when the string is NOT a valid PEP 440 version (fail closed,
 *  so garbage never matches a real release key). Drops a leading `v` and any local (`+...`) segment, strips
 *  insignificant trailing release zeros (so `1.0.0` == `1.0` == `1`), and normalizes pre/post/dev spellings and
 *  separators (so `1.0-rc1` == `1.0rc1` and `1.0-1` == `1.0.post1`). Used to match a requirement's version to
 *  PyPI's normalized release keys. */
export function pep440Key(version: string): string | null {
  const m = PEP440_RE.exec(version.trim().toLowerCase());
  if (!m) return null;
  const epoch = m[1] ?? "0";
  const release = (m[2] ?? "").split(".").map((n) => Number.parseInt(n, 10));
  while (release.length > 1 && release[release.length - 1] === 0) release.pop(); // trailing zeros are insignificant
  let pre = "";
  if (m[3]) {
    const l = m[3];
    const letter = l === "alpha" ? "a" : l === "beta" ? "b" : l === "a" || l === "b" ? l : "rc"; // c/rc/pre/preview ⇒ rc
    pre = `${letter}${m[4] ?? "0"}`;
  }
  let post = "";
  if (m[5] !== undefined) post = `post${m[5]}`; // implicit `-N` post form
  else if (m[6]) post = `post${m[7] ?? "0"}`; // post/rev/r form
  const dev = m[8] ? `dev${m[9] ?? "0"}` : "";
  return `${epoch}!${release.join(".")}${pre}${post}${dev}`;
}

/** Pure: resolve the queried version to its actual key in the `releases` map — exact string match first, then by
 *  PEP 440 equality (PyPI may publish `==1.0.0` as `1.0`). Null when nothing matches. */
export function resolvePypiReleaseKey(
  releases: PypiProjectJson["releases"],
  requested: string,
): string | null {
  if (!releases) return null;
  if (Object.prototype.hasOwnProperty.call(releases, requested)) return requested;
  const want = pep440Key(requested);
  if (want === null) return null;
  for (const key of Object.keys(releases)) {
    if (pep440Key(key) === want) return key;
  }
  return null;
}

/** Pure: the most recent upload date (ms epoch) across all releases, ignoring malformed entries and unparseable
 *  timestamps. A release value that is not an array (or a file that is not an object) is skipped, never thrown on. */
export function newestPypiUploadMs(releases: PypiProjectJson["releases"]): number | null {
  if (!releases) return null;
  let newest: number | null = null;
  for (const files of Object.values(releases)) {
    if (!Array.isArray(files)) continue; // malformed entry (e.g. an object/null under a version) → skip, fail safe
    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      const iso = file.upload_time_iso_8601 ?? file.upload_time;
      if (!iso) continue;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) continue; // garbage timestamp → ignore (fail safe)
      if (newest === null || ms > newest) newest = ms;
    }
  }
  return newest;
}

/** Pure: classify a PyPI release from the PROJECT-level JSON. The queried version is matched to its real release
 *  key by PEP 440 equality; if it cannot be resolved to a published release we report NOTHING (a maintenance signal
 *  must not be attributed to a version that may not exist on PyPI). When resolved: yanked if that release has files
 *  and every one is an object marked yanked (malformed entries fail safe, never throw); otherwise stale when the
 *  newest upload across the project's releases is older than `staleAgeMs`. */
export function pypiHealth(
  data: PypiProjectJson,
  version: string,
  staleAgeMs: number,
  now: number,
): Health | null {
  const key = resolvePypiReleaseKey(data.releases, version);
  if (key === null) return null; // requested version not a published release → no finding (fail safe)
  const files = data.releases?.[key];
  if (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((f) => f != null && typeof f === "object" && f.yanked === true)
  ) {
    const reasonFile = files.find(
      (f) =>
        f != null &&
        typeof f === "object" &&
        typeof f.yanked_reason === "string" &&
        f.yanked_reason.trim() !== "",
    );
    const why = reasonFile ? ` — ${tidyReason(reasonFile.yanked_reason as string)}` : "";
    return { kind: "yanked", reason: `release yanked from PyPI${why}` };
  }
  const newest = newestPypiUploadMs(data.releases);
  if (newest !== null && now - newest > staleAgeMs) {
    const years = Math.floor((now - newest) / (365 * 24 * 60 * 60 * 1000));
    return { kind: "stale", reason: `no release in ~${years}y (last upload ${new Date(newest).toISOString().slice(0, 10)})` };
  }
  return null;
}

/** Read a response body as text, bounded to MAX_REGISTRY_JSON_BYTES so an oversized registry payload fails closed
 *  (returns null) rather than blowing the analyzer's memory/time budget. Mirrors the bounded reader in
 *  native-build.ts: an over-cap content-length short-circuits, and a streamed body is aborted once it exceeds the cap. */
async function readJsonText(response: Response): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_REGISTRY_JSON_BYTES) return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_REGISTRY_JSON_BYTES) return null;
    return new TextDecoder().decode(buffer);
  }
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REGISTRY_JSON_BYTES) {
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

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  if (signal?.aborted) return null;
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) return null;
    const text = await readJsonText(response);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** Analyzer entrypoint: added/upgraded deps → registry metadata → only the deps that are deprecated/yanked or stale. */
export async function scanDepMaintenanceHealth(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<DepMaintenanceHealthFinding[]> {
  const staleAgeMs = options.limits?.staleAgeMs ?? STALE_AGE_MS;
  const now = Date.now();
  // Filter to queryable (supported, URL-safe) changes BEFORE applying the cap, so unsupported/invalid entries
  // can't consume the budget and starve a later real dependency.
  const changes = extractDependencyChanges(req.files ?? [])
    .filter(isQueryable)
    .slice(0, options.limits?.maxQueries ?? MAX_QUERIES);
  const findings: DepMaintenanceHealthFinding[] = [];
  for (const change of changes) {
    if (options.signal?.aborted) break;

    let health: Health | null = null;
    if (change.ecosystem === "npm") {
      const data = (await fetchJson(
        fetchImpl,
        `https://registry.npmjs.org/${encodeURIComponent(change.package)}`,
        options.signal,
      )) as NpmPackument | null;
      health = data && npmHealth(data, change.to, staleAgeMs, now);
    } else {
      // PyPI — the only other ecosystem isQueryable admits. Project-level JSON carries the full `releases` map.
      const data = (await fetchJson(
        fetchImpl,
        `https://pypi.org/pypi/${encodeURIComponent(change.package)}/json`,
        options.signal,
      )) as PypiProjectJson | null;
      health = data && pypiHealth(data, change.to, staleAgeMs, now);
    }

    if (health) {
      findings.push({
        ecosystem: change.ecosystem as "npm" | "PyPI",
        package: change.package,
        version: change.to,
        kind: health.kind,
        reason: health.reason,
      });
    }
  }
  return findings;
}

// Image/binary asset weight-delta analyzer (#1506). Flags a PR that commits or grows a heavy image/font/binary
// blob — repo + CDN/cold-start bloat the textual diff hides behind "Binary files differ". Binary sizes are not in
// the patch, so this is the one analyzer that needs the GitHub API: the git tree at headSha (and baseSha, for
// modified files) is fetched with the request's short-lived token — one recursive call returns every blob's size,
// which also sidesteps the Contents API's 1 MB cap. Pure size arithmetic after that; no external service.
// Fail-safe: returns [] without a token/headSha or when the tree fetch is not OK.
import type { EnrichRequest, AssetWeightFinding } from "../types.js";

const MAX_FILES = 50; // cap binary files inspected per PR
const THRESHOLD_BYTES = 100 * 1024; // flag a newly-added blob >= 100 KB, or growth >= 100 KB
const GITHUB_API = "https://api.github.com";

// Extensions that are genuinely binary (text formats like .svg/.json are excluded — their bytes are in the diff).
const BINARY_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tiff",
  "tif",
  "ico",
  "webp",
  "avif",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "mov",
  "avi",
  "webm",
  "mkv",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "7z",
  "rar",
  "xz",
  "pdf",
  "psd",
  "ai",
  "sketch",
  "fig",
  "xcf",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "wasm",
  "node",
  "jar",
  "class",
]);

interface ScanOptions {
  signal?: AbortSignal;
}

function isBinaryAsset(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && BINARY_EXTS.has(path.slice(dot + 1).toLowerCase());
}

/** Fetch every blob's byte size in the repo's git tree at `sha`. One recursive call. Empty map on a non-OK reply. */
async function fetchTreeSizes(
  repoFullName: string,
  sha: string,
  token: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const res = await fetchImpl(
    `${GITHUB_API}/repos/${repoFullName}/git/trees/${sha}?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "gittensory-review-enrichment",
      },
      signal,
    },
  );
  if (!res.ok) return sizes;
  const json = (await res.json()) as {
    tree?: Array<{ path?: string; type?: string; size?: number }>;
  };
  for (const entry of json.tree ?? []) {
    if (entry.type === "blob" && typeof entry.size === "number" && entry.path) {
      sizes.set(entry.path, entry.size);
    }
  }
  return sizes;
}

/** Analyzer entrypoint: flag heavy binary assets the PR adds or grows past the threshold. Pure size arithmetic over
 *  the GitHub git tree; fail-safe (returns [] without a token or on a failed tree fetch). */
export async function scanAssetWeight(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<AssetWeightFinding[]> {
  const token = req.githubToken;
  if (!token || !req.headSha) return [];

  const binaries = (req.files ?? [])
    .filter((f) => f.status !== "removed" && isBinaryAsset(f.path))
    .slice(0, MAX_FILES);
  if (!binaries.length) return [];

  const headSizes = await fetchTreeSizes(
    req.repoFullName,
    req.headSha,
    token,
    fetchImpl,
    options.signal,
  );
  const needBase = binaries.some(
    (f) => f.status === "modified" || f.status === "changed",
  );
  const baseSizes =
    needBase && req.baseSha
      ? await fetchTreeSizes(
          req.repoFullName,
          req.baseSha,
          token,
          fetchImpl,
          options.signal,
        )
      : new Map<string, number>();

  const findings: AssetWeightFinding[] = [];
  for (const file of binaries) {
    const bytes = headSizes.get(file.path);
    if (typeof bytes !== "number") continue;
    const baseBytes = baseSizes.get(file.path) ?? 0;
    const isNew = baseBytes === 0;
    const deltaBytes = bytes - baseBytes;
    if (isNew ? bytes >= THRESHOLD_BYTES : deltaBytes >= THRESHOLD_BYTES) {
      findings.push({
        path: file.path,
        bytes,
        deltaBytes,
        status: isNew ? "added" : "grown",
      });
    }
  }
  return findings;
}

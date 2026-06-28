// Verbatim-duplication analyzer (#1520). Detects code added by the PR that is a near-verbatim
// copy of an existing block elsewhere in the repo — copy-paste instead of importing the helper.
// Uses winnowing k-gram fingerprinting (Schleimer et al. 2003, jscpd/MOSS-style): normalize the
// added hunks and the repo tree, fingerprint both, flag blocks where the PR's fingerprints are
// substantially contained in an existing file. Network: GitHub git-tree (recursive) at headSha
// then git-blob per same-language file. Pure compute after the fetches; fail-safe on any error.
import type { EnrichRequest, DuplicationFinding } from "../types.js";

// Tuning constants. k=8 character k-grams avoid common short keywords while fitting 5-line blocks.
// w=4 winnowing window keeps ~1 fingerprint per 4 k-grams (Θ(n/w) per document).
const K = 8;
const W = 4;
const CONTAINMENT_THRESHOLD = 0.65; // fraction of block fingerprints that must appear in source
const MIN_BLOCK_LINES = 5;          // skip trivially-small added-line sequences
const MAX_BLOCK_CHARS = 4000;       // skip huge auto-generated blocks (unlikely to be real copy-paste)
const MAX_REPO_FILES = 150;
const MAX_FILE_BYTES = 64 * 1024;   // 64 KB per source file
const MAX_TOTAL_BYTES = 512 * 1024; // 512 KB total fetch budget
const MAX_FINDINGS = 10;
const CONCURRENT_FETCHES = 8;

// Map file extension → language group. Only compare files within the same group.
const LANGUAGE_EXT: Record<string, string> = {
  ts: "ts",  tsx: "ts",
  js: "js",  jsx: "js",  mjs: "js",  cjs: "js",
  py: "py",
  go: "go",
  rs: "rs",
  java: "java",
  c: "c",  h: "c",  cpp: "c",  cc: "c",  cxx: "c",  hpp: "c",
  cs: "cs",
  rb: "rb",
  php: "php",
  swift: "swift",
  kt: "kotlin",
};

function langOf(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_EXT[ext] ?? null;
}

/** Lowercase + collapse all whitespace to a single space. Sufficient for near-verbatim detection. */
export function normalizeForFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Compute a winnowed fingerprint: a Set of minimum k-gram hashes, one per sliding window of width w. */
export function computeFingerprint(text: string, k = K, w = W): Set<number> {
  const fps = new Set<number>();
  const n = text.length;
  if (n < k) return fps;

  // Polynomial rolling hash: h_i = sum_{j=0}^{k-1} text[i+j] * 31^(k-1-j)  (mod 2^32)
  const hashes: number[] = [];
  for (let i = 0; i + k <= n; i++) {
    let h = 0;
    for (let j = 0; j < k; j++) {
      h = (Math.imul(h, 31) + text.charCodeAt(i + j)) | 0;
    }
    hashes.push(h >>> 0);
  }

  // Winnow: for each window of width w pick the minimum hash.
  const last = hashes.length;
  if (last < w) {
    // Fewer hashes than window size — add them all.
    for (const h of hashes) fps.add(h);
  } else {
    for (let i = 0; i + w <= last; i++) {
      let min = hashes[i]!;
      for (let j = i + 1; j < i + w; j++) {
        const hj = hashes[j]!;
        if (hj < min) min = hj;
      }
      fps.add(min);
    }
  }
  return fps;
}

/** Fraction of blockFps hashes found in sourceFps (containment ≠ Jaccard; suited for block-in-file matching). */
export function fingerprintContainment(
  blockFps: Set<number>,
  sourceFps: Set<number>,
): number {
  if (blockFps.size === 0) return 0;
  let matches = 0;
  for (const h of blockFps) if (sourceFps.has(h)) matches++;
  return matches / blockFps.size;
}

export interface AddedBlock {
  headFile: string;
  headLine: number; // 1-indexed start line in the new file
  text: string;     // normalised text of the block
  lineCount: number;
}

/** Extract consecutive-added-line blocks (≥ MIN_BLOCK_LINES) from a unified diff patch. */
export function extractAddedBlocks(path: string, patch: string): AddedBlock[] {
  const blocks: AddedBlock[] = [];
  let rawLines: string[] = [];
  let blockStartLine = 0;
  let newLine = 0;

  const flush = () => {
    if (rawLines.length >= MIN_BLOCK_LINES) {
      const text = normalizeForFingerprint(rawLines.join("\n"));
      if (text.length > 0 && text.length <= MAX_BLOCK_CHARS) {
        blocks.push({ headFile: path, headLine: blockStartLine, text, lineCount: rawLines.length });
      }
    }
    rawLines = [];
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      if (rawLines.length === 0) blockStartLine = newLine;
      rawLines.push(line.slice(1));
      newLine++;
    } else {
      flush();
      if (!line.startsWith("-")) newLine++; // context line advances counter; removed lines don't
    }
  }
  flush();
  return blocks;
}

/**
 * Slide a window of `blockLineCount` lines over already-normalised source lines and return the
 * 1-indexed start line of the window with the highest fingerprint containment (≥ threshold) and
 * that containment score, or null if no window meets the threshold. The window is slightly widened
 * (+2 lines) to tolerate minor size mismatches between the PR block and the original.
 */
export function findBestSourceLine(
  blockFps: Set<number>,
  blockLineCount: number,
  sourceLinesNorm: string[],
  threshold = CONTAINMENT_THRESHOLD,
): { line: number; containment: number } | null {
  if (sourceLinesNorm.length < blockLineCount) return null;
  const windowSize = blockLineCount + 2;
  let bestLine = -1;
  let bestContainment = 0;

  for (let i = 0; i + blockLineCount <= sourceLinesNorm.length; i++) {
    const end = Math.min(i + windowSize, sourceLinesNorm.length);
    const windowText = sourceLinesNorm.slice(i, end).join(" ");
    const windowFps = computeFingerprint(windowText);
    const c = fingerprintContainment(blockFps, windowFps);
    if (c > bestContainment) {
      bestContainment = c;
      bestLine = i + 1;
    }
  }
  return bestContainment >= threshold ? { line: bestLine, containment: bestContainment } : null;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface BlobResponse {
  content?: string;
  encoding?: string;
}

/** Analyzer entrypoint: fingerprint PR-added hunks against same-language files in the repo tree. */
export async function scanVerbatimDuplication(
  req: EnrichRequest,
  fetchFn: typeof fetch,
  opts?: { signal?: AbortSignal },
): Promise<DuplicationFinding[]> {
  const { repoFullName, headSha, githubToken, files = [] } = req;

  // Requires a short-lived broker token + headSha to fetch the git tree.
  if (!githubToken || !headSha) return [];

  // Collect added blocks grouped by language.
  const langBlocks = new Map<string, AddedBlock[]>();
  const prFiles = new Set(files.map((f) => f.path));

  for (const file of files) {
    if (!file.patch) continue;
    const lang = langOf(file.path);
    if (!lang) continue;
    const blocks = extractAddedBlocks(file.path, file.patch);
    if (blocks.length === 0) continue;
    const existing = langBlocks.get(lang) ?? [];
    existing.push(...blocks);
    langBlocks.set(lang, existing);
  }

  if (langBlocks.size === 0) return [];

  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return [];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Fetch the recursive git tree to get all blob paths + SHAs.
  let treeEntries: TreeEntry[];
  try {
    const treeResp = await fetchFn(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${headSha}?recursive=1`,
      { headers, signal: opts?.signal },
    );
    if (!treeResp.ok) return [];
    const treeJson = (await treeResp.json()) as { tree?: TreeEntry[] };
    treeEntries = treeJson.tree ?? [];
  } catch {
    return [];
  }

  // Filter to blobs of the same language as the PR additions, excluding PR-modified files.
  const langs = new Set(langBlocks.keys());
  const candidates = treeEntries
    .filter((e) => e.type === "blob" && !prFiles.has(e.path) && langs.has(langOf(e.path) ?? ""))
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0)) // prefer smaller files first
    .slice(0, MAX_REPO_FILES);

  if (candidates.length === 0) return [];

  const findings: DuplicationFinding[] = [];
  let totalBytesUsed = 0;

  // Fetch blobs in bounded-concurrency batches.
  for (
    let batchStart = 0;
    batchStart < candidates.length && findings.length < MAX_FINDINGS;
    batchStart += CONCURRENT_FETCHES
  ) {
    if (totalBytesUsed >= MAX_TOTAL_BYTES) break;
    const batch = candidates.slice(batchStart, batchStart + CONCURRENT_FETCHES);

    const settled = await Promise.allSettled(
      batch.map(async (entry): Promise<{ path: string; text: string } | null> => {
        if ((entry.size ?? 0) > MAX_FILE_BYTES) return null;
        const blobResp = await fetchFn(
          `https://api.github.com/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
          { headers, signal: opts?.signal },
        );
        if (!blobResp.ok) return null;
        const blob = (await blobResp.json()) as BlobResponse;
        if (blob.encoding !== "base64" || !blob.content) return null;
        const decoded = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf-8");
        if (decoded.length > MAX_FILE_BYTES) return null;
        return { path: entry.path, text: decoded };
      }),
    );

    for (const result of settled) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { path: sourcePath, text: sourceText } = result.value;
      if (totalBytesUsed + sourceText.length > MAX_TOTAL_BYTES) continue;
      totalBytesUsed += sourceText.length;

      const lang = langOf(sourcePath);
      if (!lang) continue;
      const blocks = langBlocks.get(lang) ?? [];

      // Compute the whole-file fingerprint once per source file (cheap filter before window scan).
      const sourceNorm = normalizeForFingerprint(sourceText);
      const sourceFps = computeFingerprint(sourceNorm);
      const sourceLinesNorm = sourceText.split("\n").map((l) => normalizeForFingerprint(l));

      for (const block of blocks) {
        if (findings.length >= MAX_FINDINGS) break;
        const blockFps = computeFingerprint(block.text);
        if (blockFps.size === 0) continue;

        // Phase 1: whole-file containment — fast gate before the per-window scan.
        if (fingerprintContainment(blockFps, sourceFps) < CONTAINMENT_THRESHOLD) continue;

        // Phase 2: sliding-window scan to locate the best-matching region in the source.
        const best = findBestSourceLine(blockFps, block.lineCount, sourceLinesNorm);
        if (best === null) continue;

        findings.push({
          headFile: block.headFile,
          headLine: block.headLine,
          sourceFile: sourcePath,
          sourceLine: best.line,
          lineCount: block.lineCount,
          similarity: Math.round(best.containment * 100) / 100,
        });
      }
    }
  }

  return findings;
}

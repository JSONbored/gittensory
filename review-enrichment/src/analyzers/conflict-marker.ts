// Merge-conflict-marker analyzer (#2032). Flags leftover VCS conflict markers (`<<<<<<<`, `|||||||`,
// `=======`, `>>>>>>>`) accidentally committed in the ADDED lines of a PR diff — a mechanical, near-zero
// false-positive catch that should block a merge. Pure compute, no network. Line-cited via the hunk headers.
import type { EnrichRequest, ConflictMarkerFinding } from "../types.js";

const MAX_FINDINGS = 25;

// Git writes conflict markers as EXACTLY seven identical characters at column 0. The ours/base/theirs markers
// may be followed by a space + label (branch/commit); the separator is a bare seven `=`. Matching exactly
// seven (not six or eight) keeps the ours/base/theirs markers unambiguous — seven `<`/`|`/`>` at the start of
// a line is never valid prose or code.
const OURS_RE = /^<{7}(?: .*)?$/; // <<<<<<< HEAD
const BASE_RE = /^\|{7}(?: .*)?$/; // ||||||| merged common ancestors (diff3 conflict style)
const THEIRS_RE = /^>{7}(?: .*)?$/; // >>>>>>> feature-branch
const SEP_RE = /^={7}$/; // =======  (bare seven; guarded in markup files — see below)

// A bare `=======` line is legitimate in Markdown (a setext H1 underline) and AsciiDoc (a section rule), so the
// ambiguous separator marker is NOT flagged in those files. The ours/base/theirs markers are still flagged in
// every file type, so a real conflict landing in a Markdown file is still caught by its `<<<<<<<`/`>>>>>>>`.
const MARKUP_PATH_RE = /\.(?:md|markdown|mdx|rst|adoc|asciidoc|textile)$/i;

/** Scan one file's unified-diff patch for conflict markers on added lines, line-cited via hunk headers. Pure. */
export function scanPatchForConflictMarkers(
  path: string,
  patch: string,
  maxFindings: number = MAX_FINDINGS,
): ConflictMarkerFinding[] {
  const findings: ConflictMarkerFinding[] = [];
  if (maxFindings <= 0) return findings;
  const allowSeparator = !MARKUP_PATH_RE.test(path);
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // Skip the pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      const marker = OURS_RE.test(body)
        ? "<<<<<<<"
        : BASE_RE.test(body)
          ? "|||||||"
          : THEIRS_RE.test(body)
            ? ">>>>>>>"
            : allowSeparator && SEP_RE.test(body)
              ? "======="
              : null;
      if (marker) {
        findings.push({ file: path, line: newLine, marker });
        if (findings.length >= maxFindings) return findings;
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A context line advances the new-file cursor; a removed line and a `\ No newline at end of file`
      // marker do not (same class as the actions-pin / iac-misconfig / secret-scan line-number fix).
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's patch for leftover conflict markers. Pure, no network. */
export async function scanConflictMarkers(
  req: EnrichRequest,
): Promise<ConflictMarkerFinding[]> {
  const findings: ConflictMarkerFinding[] = [];
  for (const file of req.files ?? []) {
    if (!file.patch) continue;
    for (const finding of scanPatchForConflictMarkers(
      file.path,
      file.patch,
      MAX_FINDINGS - findings.length,
    )) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

/**
 * Shared unified-diff line helpers for analyzers that scan patch fragments which may or may not include hunk
 * headers (so they cannot rely on hunk state).
 */

/**
 * True only for a real unified-diff FILE HEADER — `+++ b/path`, `--- a/path`, or `+++ `/`--- /dev/null`
 * (marker run + space + an `a/`/`b/` prefix or `/dev/null`).
 *
 * This deliberately does NOT match added/removed CONTENT whose text begins with `++`/`--`: git renders an
 * added line whose content is `++x` as `+` + `++x` = `+++x`, and `++ x` as `+++ x`. An anchored
 * `startsWith("+++ ")` guard skips `+++ x` as if it were a header and drops the real added line; keying on the
 * header's path form scans that content while still skipping true headers.
 */
export function isDiffFileHeaderLine(line: string): boolean {
  return /^(?:\+\+\+|---) (?:[ab]\/|\/dev\/null)/.test(line);
}

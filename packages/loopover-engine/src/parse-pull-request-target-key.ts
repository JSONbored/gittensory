/**
 * Parse a pull-request target key of the form `"<owner>/<repo>#<number>"` into its repo
 * full-name and pull-number parts. Pure string parsing: returns `null` for any malformed
 * input -- falsy input, a missing / leading / trailing `#`, a repo half without a `/`, or a
 * non-integer / non-positive pull number.
 */
export function parsePullRequestTargetKey(
  targetKey: string | null | undefined,
): { repoFullName: string; pullNumber: number } | null {
  if (!targetKey) return null;
  const delimiter = targetKey.lastIndexOf("#");
  if (delimiter <= 0 || delimiter === targetKey.length - 1) return null;
  const repoFullName = targetKey.slice(0, delimiter);
  const pullNumber = Number(targetKey.slice(delimiter + 1));
  if (
    !repoFullName.includes("/") ||
    !Number.isInteger(pullNumber) ||
    pullNumber <= 0
  ) {
    return null;
  }
  return { repoFullName, pullNumber };
}

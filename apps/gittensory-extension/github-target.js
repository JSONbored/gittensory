/** @typedef {{ kind: "pull"; owner: string; repo: string; pullNumber: number }} GitHubPullTarget */
/** @typedef {{ kind: "issue"; owner: string; repo: string; issueNumber: number }} GitHubIssueTarget */
/** @typedef {GitHubPullTarget | GitHubIssueTarget} GitHubPageTarget */

const PULL_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\D|$)/;
const ISSUE_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\D|$)/;

/**
 * Parse a GitHub pathname into a supported PR or issue overlay target.
 * @param {string} pathname
 * @returns {GitHubPageTarget | null}
 */
export function parseGitHubPageTarget(pathname) {
  const path = String(pathname ?? "");
  const pullMatch = path.match(PULL_PATH_PATTERN);
  if (pullMatch) {
    const pullNumber = Number(pullMatch[3]);
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) return null;
    return { kind: "pull", owner: pullMatch[1], repo: pullMatch[2], pullNumber };
  }
  const issueMatch = path.match(ISSUE_PATH_PATTERN);
  if (issueMatch) {
    const issueNumber = Number(issueMatch[3]);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
    return { kind: "issue", owner: issueMatch[1], repo: issueMatch[2], issueNumber };
  }
  return null;
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
export function isSupportedGitHubOverlayPath(pathname) {
  return parseGitHubPageTarget(pathname) !== null;
}

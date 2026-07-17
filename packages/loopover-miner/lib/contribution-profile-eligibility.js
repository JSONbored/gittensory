// Contribution-eligibility filtering (#6798): the last piece of the AMS contribution-profile epic (#6793).
// Applies a target repo's ContributionProfile (#6795/#6796) to `discover`'s fanned-out candidates, excluding ones
// that fail the profile's eligibility rules -- BEFORE ranking/enqueueing, so a real repo's own conventions are
// respected instead of surfacing a candidate its maintainer would reject on arrival.
//
// Safe-default posture: a label-based rule only ever excludes when the profile actually resolved a matcher list
// for it (`value` non-null). A repo with no discoverable eligibility/exclusion label signal at all -- `value:
// null`, the "degrade honestly" outcome #6796 produces for an unreadable or convention-less repo -- excludes
// nothing via that rule. This falls straight out of "there is nothing to check a candidate against," not a
// separate confidence gate bolted on top: `discover` never silently skips real work on a repo whose conventions
// it simply couldn't read. The one check that is NOT gated on profile confidence is assignee-exclusion: per the
// schema (#6795), it is a live, structural fact ("this issue is assigned to the repo owner"), not something
// extraction infers, so it applies to every candidate regardless of how much (or how little) the profile knows.
//
// Conflicting signals (a candidate matches both an eligibility AND an exclusion matcher) resolve conservatively:
// exclusion always wins. The eligibility check only ever ADDS a reason when NO matcher matched; the exclusion
// check only ever ADDS a reason when one DID -- so a candidate that clears eligibility but also trips exclusion
// carries just the exclusion reason, and is excluded either way.

const DEFAULT_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 10_000;

function labelMatchesMatcher(matcher, labelNames, labelDescriptionsByName) {
  const term = matcher.contains.toLowerCase();
  if (matcher.field === "description") {
    if (!labelDescriptionsByName) return false;
    return labelNames.some((name) => {
      const description = labelDescriptionsByName.get(name.toLowerCase());
      return typeof description === "string" && description.toLowerCase().includes(term);
    });
  }
  return labelNames.some((name) => name.toLowerCase().includes(term));
}

function anyMatcherMatches(matchers, labelNames, labelDescriptionsByName) {
  return matchers.some((matcher) => labelMatchesMatcher(matcher, labelNames, labelDescriptionsByName));
}

/**
 * Evaluate one candidate issue against a repo's ContributionProfile. Never throws; a missing/malformed `profile`
 * behaves exactly like a fully-absent one (excludes nothing via the label rules).
 *
 * @param {import("./opportunity-fanout.js").RawCandidateIssue} issue
 * @param {import("./contribution-profile.js").ContributionProfile | null | undefined} profile
 * @param {{ labelDescriptionsByName?: Map<string, string | null>, excludeAssignedLogins?: string[] }} [options]
 * @returns {{ excluded: boolean, reasons: string[] }}
 */
export function evaluateCandidateEligibility(issue, profile, options = {}) {
  const reasons = [];

  const eligibilityMatchers = profile?.eligibilityLabels?.value;
  if (Array.isArray(eligibilityMatchers) && eligibilityMatchers.length > 0) {
    if (!anyMatcherMatches(eligibilityMatchers, issue.labels, options.labelDescriptionsByName)) {
      reasons.push("missing eligibility label");
    }
  }

  const exclusionMatchers = profile?.exclusionLabels?.value;
  if (Array.isArray(exclusionMatchers) && exclusionMatchers.length > 0) {
    if (anyMatcherMatches(exclusionMatchers, issue.labels, options.labelDescriptionsByName)) {
      reasons.push("exclusion label present");
    }
  }

  // Structural, always-on (not gated on profile confidence, see header comment): defaults to the repo's own
  // owner login, already present on the candidate -- no extra lookup needed.
  const excludeAssignedLogins = options.excludeAssignedLogins ?? [issue.owner];
  const normalizedExcludedLogins = new Set(excludeAssignedLogins.map((login) => String(login).toLowerCase()));
  if (issue.assignees.some((login) => normalizedExcludedLogins.has(String(login).toLowerCase()))) {
    reasons.push("excluded assignee");
  }

  return { excluded: reasons.length > 0, reasons };
}

/**
 * Split fanned-out candidates into eligible and excluded, per each candidate's own repo profile.
 *
 * @param {import("./opportunity-fanout.js").RawCandidateIssue[]} issues
 * @param {Map<string, import("./contribution-profile.js").ContributionProfile>} profilesByRepo
 * @param {{ labelDescriptionsByRepo?: Map<string, Map<string, string | null>> }} [options]
 * @returns {{
 *   eligible: import("./opportunity-fanout.js").RawCandidateIssue[],
 *   excluded: Array<{ issue: import("./opportunity-fanout.js").RawCandidateIssue, reasons: string[] }>,
 * }}
 */
export function filterEligibleCandidates(issues, profilesByRepo, options = {}) {
  const eligible = [];
  const excluded = [];
  for (const issue of issues) {
    const profile = profilesByRepo.get(issue.repoFullName) ?? null;
    const labelDescriptionsByName = options.labelDescriptionsByRepo?.get(issue.repoFullName);
    const result = evaluateCandidateEligibility(issue, profile, { labelDescriptionsByName });
    if (result.excluded) {
      excluded.push({ issue, reasons: result.reasons });
    } else {
      eligible.push(issue);
    }
  }
  return { eligible, excluded };
}

/** True when a profile carries at least one description-field matcher -- the only case that needs the repo's
 *  full label list (name + description), not just the names `discover` already has on each candidate. Keeps the
 *  extra `/labels` fetch conditional on actually needing it, instead of paying it for every repo. */
export function profileNeedsLabelDescriptions(profile) {
  const matcherLists = [profile?.eligibilityLabels?.value, profile?.exclusionLabels?.value];
  return matcherLists.some(
    (matchers) => Array.isArray(matchers) && matchers.some((matcher) => matcher.field === "description"),
  );
}

function githubHeaders(githubToken) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "loopover-miner",
    "x-github-api-version": GITHUB_API_VERSION,
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  return headers;
}

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner?.trim() || !repo?.trim() || extra !== undefined) return null;
  return { owner: owner.trim(), repo: repo.trim() };
}

/**
 * Fetch a repo's full label list (name + description) as a `Map<lowercased name, description>`. Never throws:
 * any transport/HTTP/parse failure or malformed repo name yields an empty map, so a fetch problem degrades a
 * description-field matcher to "no match" rather than aborting discovery. Only worth calling when
 * `profileNeedsLabelDescriptions` is true for the target repo.
 *
 * @param {string} repoFullName
 * @param {{ fetchImpl?: typeof fetch, githubToken?: string, apiBaseUrl?: string }} [options]
 * @returns {Promise<Map<string, string | null>>}
 */
export async function fetchRepoLabelDescriptions(repoFullName, options = {}) {
  const target = parseRepoFullName(repoFullName);
  if (target === null) return new Map();

  /* v8 ignore next -- the global-fetch default is the production path; every test injects fetchImpl. */
  const fetchImpl = options.fetchImpl ?? fetch;
  const base =
    typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
      ? options.apiBaseUrl.replace(/\/+$/, "")
      : DEFAULT_API_BASE_URL;
  const headers = githubHeaders(options.githubToken);

  let response;
  try {
    response = await fetchImpl(`${base}/repos/${target.owner}/${target.repo}/labels?per_page=100`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return new Map();
  }
  if (!response.ok) return new Map();
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) return new Map();

  const byName = new Map();
  for (const label of payload) {
    if (typeof label?.name === "string") {
      byName.set(label.name.toLowerCase(), typeof label.description === "string" ? label.description : null);
    }
  }
  return byName;
}

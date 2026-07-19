// Real GitHub-backed fetchLiveIssueSnapshot (#5132, Wave 3.5). AttemptDeps.fetchLiveIssueSnapshot and
// SubmissionFreshnessDeps.fetchLiveIssueSnapshot (submission-freshness-check.js) share this one shape:
// "is this issue still open, and is it already addressed by another PR" -- the live-state answer
// checkSubmissionFreshness needs before every submission. Uses GitHub's GraphQL
// `closedByPullRequestsReferences` connection rather than a body-text/search-API heuristic: it's GitHub's
// own authoritative, closing-keyword-aware answer to "which PRs will close this issue" -- the same signal
// the platform itself uses to auto-close on merge, not a regex we'd have to keep in sync with GitHub's own
// closing-keyword parsing.
const DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_REFERENCING_PRS = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const LIVE_ISSUE_SNAPSHOT_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $maxPrs: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        state
        closedByPullRequestsReferences(first: $maxPrs) {
          nodes {
            number
            state
            author { login }
            createdAt
          }
        }
      }
    }
  }
`;
function githubGraphqlHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "loopover-miner",
        "x-github-api-version": GITHUB_API_VERSION,
    };
    const token = typeof githubToken === "string" ? githubToken.trim() : "";
    if (token)
        headers.authorization = `Bearer ${token}`;
    return headers;
}
function normalizeIssueOrPrState(rawState) {
    return typeof rawState === "string" ? rawState.toLowerCase() : "";
}
function normalizeReferencingPr(node) {
    if (!node || typeof node !== "object")
        return null;
    const record = node;
    if (!Number.isInteger(record.number) || record.number <= 0)
        return null;
    const state = normalizeIssueOrPrState(record.state);
    if (state !== "open" && state !== "closed" && state !== "merged")
        return null;
    const authorLogin = typeof record.author?.login === "string" ? record.author.login : "";
    // GitHub's real PR creation timestamp (ISO 8601), when present -- null otherwise (never fabricated). Not
    // an ordering signal for the maintainer gate's own duplicate-cluster election (duplicate-winner.ts's own
    // doc explains why: a PR can be backdated by editing an old placeholder to add the linked issue later), but
    // it's the only real, publicly-observable claim-time proxy claim-conflict-resolver.js's own client-side
    // caller has for a THIRD-PARTY PR -- unlike loopover's own server, the miner has no continuous observation
    // history to derive a true "first linked" timestamp from.
    const createdAt = typeof record.createdAt === "string" ? record.createdAt : null;
    return { number: record.number, state, authorLogin, createdAt };
}
function parseRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        return null;
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
/**
 * Real fetchLiveIssueSnapshot implementation: the live-state answer AttemptDeps/SubmissionFreshnessDeps
 * need, built from a single GraphQL round-trip. Returns null on any malformed input, transport failure, or
 * unrecognized GitHub response -- callers already treat a null snapshot as "state unavailable", so this
 * never throws.
 */
export async function fetchLiveIssueSnapshot(repoFullName, issueNumber, options = {}) {
    const target = parseRepoFullName(repoFullName);
    if (!target || !Number.isInteger(issueNumber) || issueNumber <= 0)
        return null;
    const graphqlUrl = typeof options.graphqlUrl === "string" && options.graphqlUrl.trim() ? options.graphqlUrl.trim() : DEFAULT_GRAPHQL_URL;
    const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN ?? "";
    const fetchImpl = options.fetchImpl ?? fetch;
    const requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
    // Bounded so a stalled connection can't hang this "never throws" fetcher forever (#miner-github-read-timeouts):
    // a timeout falls into the SAME catch as any other transport failure, which the caller (checkSubmissionFreshness)
    // already treats as "live_state_unavailable" -- a fail-closed abort distinct from "issue_closed"/"already_addressed",
    // never confused with a confirmed-gone issue.
    let response;
    try {
        response = await fetchImpl(graphqlUrl, {
            method: "POST",
            headers: githubGraphqlHeaders(githubToken),
            body: JSON.stringify({
                query: LIVE_ISSUE_SNAPSHOT_QUERY,
                variables: { owner: target.owner, repo: target.repo, number: issueNumber, maxPrs: MAX_REFERENCING_PRS },
            }),
            signal: AbortSignal.timeout(requestTimeoutMs),
        });
    }
    catch {
        return null;
    }
    if (!response.ok)
        return null;
    const payload = (await response.json().catch(() => null));
    if (!payload || typeof payload !== "object" || payload.errors)
        return null;
    const issue = payload.data?.repository?.issue;
    const state = normalizeIssueOrPrState(issue?.state);
    if (state !== "open" && state !== "closed")
        return null;
    const nodes = Array.isArray(issue?.closedByPullRequestsReferences?.nodes) ? issue.closedByPullRequestsReferences.nodes : [];
    const referencingPrs = nodes.map(normalizeReferencingPr).filter((pr) => pr !== null);
    return { state, referencingPrs };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGl2ZS1pc3N1ZS1zbmFwc2hvdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImxpdmUtaXNzdWUtc25hcHNob3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBRUEsc0dBQXNHO0FBQ3RHLHVHQUF1RztBQUN2RyxpR0FBaUc7QUFDakcsZ0ZBQWdGO0FBQ2hGLDBHQUEwRztBQUMxRywwR0FBMEc7QUFDMUcsMkdBQTJHO0FBQzNHLDJCQUEyQjtBQUUzQixNQUFNLG1CQUFtQixHQUFHLGdDQUFnQyxDQUFDO0FBQzdELE1BQU0sa0JBQWtCLEdBQUcsWUFBWSxDQUFDO0FBQ3hDLE1BQU0sbUJBQW1CLEdBQUcsRUFBRSxDQUFDO0FBQy9CLE1BQU0sMEJBQTBCLEdBQUcsTUFBTSxDQUFDO0FBRTFDLE1BQU0seUJBQXlCLEdBQUc7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQmpDLENBQUM7QUFXRixTQUFTLG9CQUFvQixDQUFDLFdBQW1CO0lBQy9DLE1BQU0sT0FBTyxHQUEyQjtRQUN0QyxNQUFNLEVBQUUsNkJBQTZCO1FBQ3JDLGNBQWMsRUFBRSxrQkFBa0I7UUFDbEMsWUFBWSxFQUFFLGdCQUFnQjtRQUM5QixzQkFBc0IsRUFBRSxrQkFBa0I7S0FDM0MsQ0FBQztJQUNGLE1BQU0sS0FBSyxHQUFHLE9BQU8sV0FBVyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDeEUsSUFBSSxLQUFLO1FBQUUsT0FBTyxDQUFDLGFBQWEsR0FBRyxVQUFVLEtBQUssRUFBRSxDQUFDO0lBQ3JELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLFFBQWlCO0lBQ2hELE9BQU8sT0FBTyxRQUFRLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUNwRSxDQUFDO0FBRUQsU0FBUyxzQkFB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
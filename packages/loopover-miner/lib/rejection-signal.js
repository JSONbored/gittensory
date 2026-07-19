import { resolveAiPolicyVerdict } from "@loopover/engine";
import { listRecentOwnSubmissions } from "./governor-state.js";
import { resolveRejection } from "./rejection-state-machine.js";
export const REJECTION_REASON_AI_USAGE_POLICY_BAN = "ai_usage_policy_ban";
export const REJECTION_REASON_OWN_SUBMISSION_REJECTED = "own_submission_rejected";
const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";
const MAX_POLICY_DOC_BYTES = 128 * 1024;
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
// Bound the per-call PR-status fetch fan-out (#5655): a miner with a long submission history on one repo must
// not trigger an unbounded burst of GitHub API calls on every attempt -- only the N most recent are checked.
const DEFAULT_MAX_REJECTION_HISTORY_CHECKS = 10;
function parseRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        return null;
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
function normalizeOptions(options = {}) {
    return {
        rawContentBaseUrl: typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
        fetchImpl: options.fetchImpl ?? fetch,
    };
}
async function readBoundedPolicyDoc(response) {
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength !== undefined && contentLength !== null) {
        const parsedLength = Number.parseInt(contentLength, 10);
        if (Number.isFinite(parsedLength) && parsedLength > MAX_POLICY_DOC_BYTES)
            return null;
    }
    if (!response.body?.getReader) {
        const text = await response.text();
        return typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_POLICY_DOC_BYTES ? text : null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_POLICY_DOC_BYTES) {
                await reader.cancel();
                return null;
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
    }
    finally {
        reader.releaseLock();
    }
}
async function fetchPolicyDoc(target, path, resolved) {
    const url = `${resolved.rawContentBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/HEAD/${path}`;
    try {
        const response = await resolved.fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": "loopover-miner" } });
        if (!response.ok)
            return null;
        return await readBoundedPolicyDoc(response);
    }
    catch {
        return null;
    }
}
async function fetchPullRequestPayload(target, prNumber, resolved) {
    const url = `${resolved.githubApiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${prNumber}`;
    const headers = { accept: "application/vnd.github+json", "user-agent": "loopover-miner" };
    if (resolved.githubToken)
        headers.authorization = `Bearer ${resolved.githubToken}`;
    const response = await resolved.fetchImpl(url, { method: "GET", headers });
    if (!response.ok)
        return null;
    return await response.json();
}
/**
 * Resolve the SECOND `rejectionSignaled` trigger (#5655): has a prior submission from THIS miner on THIS exact
 * repo already been closed/rejected? Reads this miner's own recorded submissions on the repo
 * (`listRecentOwnSubmissions`, #5134), fetches each one's live PR state, and runs it through `resolveRejection`
 * (#4278) -- returning `true` if ANY was closed without merge. Bounded (only the most recent
 * `maxRejectionHistoryChecks` submissions with a real PR number are fetched) and fully fail-open: a wholesale
 * failure to read submissions resolves to `false` (never fabricated as a rejection), and any single PR
 * fetch/parse failure is skipped so it never blocks the others. Consumes both upstream modules without modifying
 * either. Every dependency is injectable for testing.
 */
export async function resolveOwnRejectionHistory(repoFullName, options = {}) {
    const target = parseRepoFullName(repoFullName);
    if (!target)
        return false;
    const listSubmissions = options.listSubmissions ?? listRecentOwnSubmissions;
    const resolved = {
        fetchImpl: options.fetchImpl ?? fetch,
        githubToken: typeof options.githubToken === "string" ? options.githubToken.trim() : (process.env.GITHUB_TOKEN ?? ""),
        githubApiBaseUrl: typeof options.githubApiBaseUrl === "string" && options.githubApiBaseUrl.trim() ? options.githubApiBaseUrl.trim() : DEFAULT_GITHUB_API_BASE_URL,
        maxChecks: Number.isInteger(options.maxRejectionHistoryChecks) && options.maxRejectionHistoryChecks > 0
            ? options.maxRejectionHistoryChecks
            : DEFAULT_MAX_REJECTION_HISTORY_CHECKS,
    };
    let submissions;
    try {
        submissions = listSubmissions({ repoFullName });
    }
    catch {
        return false; // wholesale failure to read own submissions -- fail open, never fabricate a rejection
    }
    const checkable = (Array.isArray(submissions) ? submissions : [])
        .filter((submission) => Boolean(submission) && Number.isInteger(submission.pullRequestNumber) && submission.pullRequestNumber > 0)
        .slice(0, resolved.maxChecks);
    if (checkable.length === 0)
        return false; // no prior submissions on this repo -- no fetch attempted
    for (const submission of checkable) {
        try {
            const payload = await fetchPullRequestPayload(target, submission.pullRequestNumber, resolved);
            if (!payload)
                continue;
            // No signal (gate/duplicate context isn't available here) -- resolveRejection returns non-null only for a
            // PR that is closed-without-merge, which is exactly the "was it rejected" question this check asks.
            const rejection = resolveRejection(payload, undefined, { repoFullName, prNumber: submission.pullRequestNumber });
            if (rejection)
                return true;
        }
        catch {
            // Individual PR fetch/parse/classify failure -- skip this one, keep checking the rest (fail open).
        }
    }
    return false;
}
/**
 * Resolve whether the target repo has signaled it does not want automated/AI-authored contributions --
 * either trigger documented above. Returns `false` (never throws) on any fetch/parse failure for the policy
 * docs, matching resolveAiPolicyVerdict's own fail-open default for an absent/unreadable policy doc. When a
 * trigger fires, returns a trigger-specific reason string so callers can label audit-trail events accurately.
 */
export async function resolveRejectionSignaled(repoFullName, options = {}) {
    const target = parseRepoFullName(repoFullName);
    if (!target)
        return false;
    const resolved = normalizeOptions(options);
    const aiUsage = await fetchPolicyDoc(target, "AI-USAGE.md", resolved);
    const contributing = aiUsage && aiUsage.trim() ? null : await fetchPolicyDoc(target, "CONTRIBUTING.md", resolved);
    const verdict = resolveAiPolicyVerdict({ aiUsage, contributing });
    // First trigger: an explicit live AI-usage-policy ban. A ban short-circuits -- no need to also check history.
    if (!verdict.allowed)
        return REJECTION_REASON_AI_USAGE_POLICY_BAN;
    // Second trigger (#5655): a prior submission from this same miner on this exact repo was closed/rejected.
    const ownHistoryRejected = await resolveOwnRejectionHistory(repoFullName, options);
    return ownHistoryRejected ? REJECTION_REASON_OWN_SUBMISSION_REJECTED : false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVqZWN0aW9uLXNpZ25hbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJlamVjdGlvbi1zaWduYWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLHNCQUFzQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDMUQsT0FBTyxFQUFFLHdCQUF3QixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDL0QsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFvQ2hFLE1BQU0sQ0FBQyxNQUFNLG9DQUFvQyxHQUFHLHFCQUFxQixDQUFDO0FBQzFFLE1BQU0sQ0FBQyxNQUFNLHdDQUF3QyxHQUFHLHlCQUF5QixDQUFDO0FBRWxGLE1BQU0sNEJBQTRCLEdBQUcsbUNBQW1DLENBQUM7QUFDekUsTUFBTSxvQkFBb0IsR0FBRyxHQUFHLEdBQUcsSUFBSSxDQUFDO0FBQ3hDLE1BQU0sMkJBQTJCLEdBQUcsd0JBQXdCLENBQUM7QUFDN0QsOEdBQThHO0FBQzlHLDZHQUE2RztBQUM3RyxNQUFNLG9DQUFvQyxHQUFHLEVBQUUsQ0FBQztBQUloRCxTQUFTLGlCQUFpQixDQUFDLFlBQXFCO0lBQzlDLElBQUksT0FBTyxZQUFZLEtBQUssUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ2xELE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDckQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3hELE9BQU8sRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQUM7QUFDekIsQ0FBQztBQU9ELFNBQVMsZ0JBQWdCLENBQUMsVUFBb0MsRUFBRTtJQUM5RCxPQUFPO1FBQ0wsaUJBQWlCLEVBQ2YsT0FBTyxPQUFPLENBQUMsaUJBQWlCLEtBQUssUUFBUSxJ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
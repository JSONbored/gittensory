import { buildCollisionReport, buildIssueQualityReport, MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent, } from "@loopover/engine";
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";
const DEFAULT_GITTENSOR_API_BASE = "https://api.gittensor.io";
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Short ORB probe budget (#6487) — must never make discover/gate-prediction meaningfully slower when ORB is absent. */
const DEFAULT_LIVE_GATE_PROBE_TIMEOUT_MS = 400;
// Mirrors src/signals/focus-manifest-loader.ts's MANIFEST_FILE_CANDIDATES exactly -- first candidate that
// resolves wins, same as the live gate's own lookup order.
const MANIFEST_FILE_CANDIDATES = [".loopover.yml", ".github/loopover.yml", ".loopover.json", ".github/loopover.json"];
function parseRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        return null;
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
function githubHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "loopover-miner",
        "x-github-api-version": GITHUB_API_VERSION,
    };
    const token = typeof githubToken === "string" ? githubToken.trim() : "";
    if (token)
        headers.authorization = `Bearer ${token}`;
    return headers;
}
function normalizeOptions(options = {}) {
    const env = options.env ?? process.env;
    // Explicit null skips the probe (tests / forced-standalone). Undefined ⇒ resolve from loopover-mcp session.
    const loopoverAuth = options.loopoverAuth === null
        ? null
        : options.loopoverAuth && typeof options.loopoverAuth.sessionToken === "string" && options.loopoverAuth.sessionToken
            ? {
                apiUrl: typeof options.loopoverAuth.apiUrl === "string" && options.loopoverAuth.apiUrl.trim()
                    ? options.loopoverAuth.apiUrl.replace(/\/+$/, "")
                    : (resolveLoopoverBackendSession(env)?.apiUrl ?? "https://api.loopover.ai"),
                sessionToken: options.loopoverAuth.sessionToken,
            }
            : resolveLoopoverBackendSession(env);
    return {
        githubToken: options.githubToken ?? env.GITHUB_TOKEN ?? "",
        apiBaseUrl: typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl.trim() : DEFAULT_API_BASE_URL,
        rawContentBaseUrl: typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
        gittensorApiBase: typeof options.gittensorApiBase === "string" && options.gittensorApiBase.trim() ? options.gittensorApiBase.trim() : DEFAULT_GITTENSOR_API_BASE,
        fetchImpl: options.fetchImpl ?? fetch,
        perPage: Number.isInteger(options.perPage) && options.perPage > 0 ? options.perPage : DEFAULT_PER_PAGE,
        maxPages: Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : DEFAULT_MAX_PAGES,
        contributorLogin: typeof options.contributorLogin === "string" ? options.contributorLogin.trim() : "",
        linkedIssues: Array.isArray(options.linkedIssues) ? options.linkedIssues.filter((n) => Number.isInteger(n)) : [],
        requestTimeoutMs: Number.isInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS,
        liveGateProbeTimeoutMs: Number.isInteger(options.liveGateProbeTimeoutMs) && options.liveGateProbeTimeoutMs > 0
            ? options.liveGateProbeTimeoutMs
            : DEFAULT_LIVE_GATE_PROBE_TIMEOUT_MS,
        loopoverAuth,
    };
}
/** Validate the field-limited #6486/#6487 payload; null when nothing usable is present. */
export function parseLiveGateThresholdFields(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const record = payload;
    const confidence_floor = typeof record.confidence_floor === "number" && record.confidence_floor >= 0 && record.confidence_floor <= 1
        ? record.confidence_floor
        : null;
    const scope_cap_files = typeof record.scope_cap_files === "number" && record.scope_cap_files > 0 ? record.scope_cap_files : null;
    const scope_cap_lines = typeof record.scope_cap_lines === "number" && record.scope_cap_lines > 0 ? record.scope_cap_lines : null;
    if (confidence_floor === null && scope_cap_files === null && scope_cap_lines === null)
        return null;
    return { confidence_floor, scope_cap_files, scope_cap_lines };
}
/**
 * Overlay live ORB thresholds onto a statically-reconstructed FocusManifest (#6487).
 * - confidence_floor → raise-only readinessMinScore (mirrors applySelfTuneOverrideToSettings).
 * - scope_cap_files / scope_cap_lines → prefer live sizeMaxFiles / sizeMaxLines when present.
 * Other gate fields are left untouched.
 */
export function applyLiveGateThresholdsToManifest(manifest, fields) {
    if (!manifest || !fields)
        return manifest;
    const gate = { ...manifest.gate };
    if (typeof fields.confidence_floor === "number") {
        const floorScore = Math.max(0, Math.min(100, Math.round(fields.confidence_floor * 100)));
        if (typeof gate.readinessMinScore === "number" && floorScore > gate.readinessMinScore) {
            gate.readinessMinScore = floorScore;
        }
    }
    if (typeof fields.scope_cap_files === "number" && fields.scope_cap_files > 0) {
        gate.sizeMaxFiles = fields.scope_cap_files;
    }
    if (typeof fields.scope_cap_lines === "number" && fields.scope_cap_lines > 0) {
        gate.sizeMaxLines = fields.scope_cap_lines;
    }
    return { ...manifest, gate };
}
async function probeLiveGateThresholds(target, resolved) {
    const auth = resolved.loopoverAuth;
    if (!auth?.sessionToken)
        return null;
    const url = `${auth.apiUrl}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/live-gate-thresholds`;
    try {
        const response = await fetchWithTimeout(resolved.fetchImpl, url, {
            method: "GET",
            headers: {
                authorization: `Bearer ${auth.sessionToken}`,
                accept: "application/json",
                "user-agent": "loopover-miner",
            },
        }, resolved.liveGateProbeTimeoutMs);
        if (!response.ok)
            return null;
        const payload = await response.json().catch(() => null);
        return parseLiveGateThresholdFields(payload);
    }
    catch {
        return null;
    }
}
// A fresh AbortSignal.timeout() per call, so a stalled connection can't hang context construction forever
// (#miner-github-read-timeouts) -- shared by this file's three independent fetch call sites (GitHub REST, raw
// manifest content, the Gittensor contributor lookup).
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
async function githubGetJson(url, resolved) {
    const response = await fetchWithTimeout(resolved.fetchImpl, url, { method: "GET", headers: githubHeaders(resolved.githubToken) }, resolved.requestTimeoutMs);
    const payload = await response.json().catch(() => null);
    return { response, payload };
}
async function fetchPaginated(pathWithQuery, resolved) {
    const results = [];
    for (let page = 1; page <= resolved.maxPages; page += 1) {
        // fetchPaginated's only two callers (fetchOpenIssueRecords / fetchOpenPullRequestRecords) always pass a
        // path that already carries a `?state=open&...` query, so `includes("?")` is always true and the `: "?"`
        // no-query branch has no reachable caller -- the one branch in these 8 files with genuinely no test seam.
        /* v8 ignore next -- no caller passes a query-less path; the ": ?" branch is unreachable */
        const separator = pathWithQuery.includes("?") ? "&" : "?";
        const url = `${resolved.apiBaseUrl}${pathWithQuery}${separator}per_page=${resolved.perPage}&page=${page}`;
        const { response, payload } = await githubGetJson(url, resolved);
        if (!response.ok || !Array.isArray(payload))
            break;
        results.push(...payload);
        if (payload.length < resolved.perPage)
            break;
    }
    return results;
}
// Mirrors src/db/repositories.ts's toRepositoryRecord + upsertRepositoryFromGitHub's field mapping. The
// miner has no App installation/DB, so installationId/isInstalled/isRegistered/registryConfig are honest
// "unregistered" defaults, not values pulled from GitHub -- GitHub's own repo payload carries none of them.
async function fetchRepositoryRecord(target, resolved) {
    const url = `${resolved.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
    const { response, payload } = await githubGetJson(url, resolved);
    if (!response.ok || !payload || typeof payload !== "object")
        return null;
    const repo = payload;
    return {
        fullName: `${target.owner}/${target.repo}`,
        owner: repo.owner?.login ?? target.owner,
        name: repo.name ?? target.repo,
        installationId: undefined,
        isInstalled: false,
        isRegistered: false,
        isPrivate: repo.private ?? false,
        htmlUrl: repo.html_url ?? null,
        defaultBranch: repo.default_branch ?? null,
        registryConfig: null,
    };
}
// Mirrors src/db/repositories.ts's extractLinkedPrNumbers: a real link needs a CLOSING KEYWORD, not a bare
// mention (#6769). Without the keyword prefix, an incidental "similar to what we saw in PR #501" in an issue
// body counted as a linked PR, so the issue-quality report read the issue as "already references a PR" and the
// miner skipped an available issue (the host's own #issue-body-pr-mention-pollution fix, never ported here).
const LINKED_PR_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:PR|pull request)\s+#(\d+)\b/gi;
function extractLinkedPrNumbers(body) {
    const numbers = [];
    for (const match of body.matchAll(LINKED_PR_PATTERN)) {
        const number = Number(match[1]);
        if (Number.isInteger(number) && number > 0)
            numbers.push(number);
    }
    return numbers;
}
// Mirrors src/db/repositories.ts's extractLinkedIssueNumbers: GitHub's own closing-keyword vocabulary, only
// counting a fully-qualified owner/repo#N reference when it targets the SAME repo being fetched.
const LINKED_ISSUE_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+)#|#)(\d+)\b/gi;
function extractLinkedIssueNumbers(body, repoFullName) {
    // Strip backtick code spans first so a closing-keyword pattern quoted as example code doesn't count.
    const withoutCodeSpans = body.replace(/`[^`]*`/g, "");
    const numbers = [];
    const normalizedRepo = repoFullName.toLowerCase();
    for (const match of withoutCodeSpans.matchAll(LINKED_ISSUE_PATTERN)) {
        const qualifiedRepo = match[1];
        if (qualifiedRepo !== undefined && qualifiedRepo.toLowerCase() !== normalizedRepo)
            continue;
        const number = Number(match[2]);
        if (Number.isInteger(number) && number > 0)
            numbers.push(number);
    }
    return numbers;
}
function labelNames(labels) {
    if (!Array.isArray(labels))
        return [];
    return labels.flatMap((label) => (label && typeof label === "object" && typeof label.name === "string" ? [label.name] : []));
}
// Mirrors src/db/repositories.ts's toIssueRecord, populated straight from the live payload (createdAt/
// updatedAt/closedAt come from the DB-row read path there only as a caching artifact, not a semantic
// transform -- the live REST fields are the real source).
function toIssueRecord(repoFullName, issue) {
    const body = issue.body ?? "";
    return {
        repoFullName,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        authorLogin: issue.user?.login ?? null,
        authorAssociation: issue.author_association ?? null,
        htmlUrl: issue.html_url ?? null,
        body,
        createdAt: issue.created_at ?? null,
        updatedAt: issue.updated_at ?? null,
        closedAt: issue.closed_at ?? null,
        labels: labelNames(issue.labels),
        linkedPrs: extractLinkedPrNumbers(body),
    };
}
async function fetchOpenIssueRecords(target, resolved) {
    const payloads = await fetchPaginated(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues?state=open&sort=created&direction=asc`, resolved);
    // GitHub's Issues endpoint also returns pull requests -- filter them out, same as the live gate's own fetch.
    return payloads
        .filter((issue) => issue && typeof issue === "object" && !issue.pull_request)
        .map((issue) => toIssueRecord(`${target.owner}/${target.repo}`, issue));
}
function mergeableBooleanState(mergeable) {
    if (mergeable === true)
        return "clean";
    if (mergeable === false)
        return "dirty";
    return null;
}
// Mirrors src/db/repositories.ts's toPullRequestRecord. Only the fields SelfReviewContext/buildCollisionReport
// actually consume are populated with real precision; merge/RC3 gate-plumbing fields the live gate's fuller
// PullRequestRecord carries (mergeAttemptCount, approvedHeadSha, ...) don't exist on the engine package's
// leaner mirror type and aren't meaningful for a miner attempt anyway.
function toPullRequestRecord(repoFullName, pr) {
    const body = pr.body ?? "";
    return {
        repoFullName,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        authorLogin: pr.user?.login ?? null,
        authorAssociation: pr.author_association ?? null,
        headSha: pr.head?.sha ?? null,
        headRef: pr.head?.ref ?? null,
        baseRef: pr.base?.ref ?? null,
        htmlUrl: pr.html_url ?? null,
        mergedAt: pr.merged_at ?? null,
        isDraft: pr.draft ?? null,
        mergeableState: pr.mergeable_state ?? mergeableBooleanState(pr.mergeable),
        reviewDecision: null,
        body,
        createdAt: pr.created_at ?? null,
        updatedAt: pr.updated_at ?? null,
        closedAt: pr.closed_at ?? null,
        labels: labelNames(pr.labels),
        linkedIssues: extractLinkedIssueNumbers(body, repoFullName),
    };
}
async function fetchOpenPullRequestRecords(target, resolved) {
    const payloads = await fetchPaginated(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls?state=open&sort=created&direction=asc`, resolved);
    return payloads.map((pr) => toPullRequestRecord(`${target.owner}/${target.repo}`, pr));
}
// Mirrors src/signals/focus-manifest-loader.ts's raw-content lookup order and bounded body read:
// first candidate path that resolves wins, but hostile manifests never exceed the parser byte cap in memory.
async function readBoundedManifestResponseText(response) {
    const contentLength = response.headers?.get?.("content-length") ?? null;
    if (contentLength !== null) {
        const parsedLength = Number.parseInt(contentLength, 10);
        if (Number.isFinite(parsedLength) && parsedLength > MAX_FOCUS_MANIFEST_BYTES)
            return null;
    }
    if (!response.body?.getReader) {
        const text = await response.text();
        if (typeof text !== "string")
            return null;
        return new TextEncoder().encode(text).byteLength > MAX_FOCUS_MANIFEST_BYTES ? null : text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_FOCUS_MANIFEST_BYTES) {
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
async function fetchManifestContent(target, resolved) {
    for (const path of MANIFEST_FILE_CANDIDATES) {
        const url = `${resolved.rawContentBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/HEAD/${path}`;
        try {
            const response = await fetchWithTimeout(resolved.fetchImpl, url, { method: "GET", headers: { accept: "application/json", "user-agent": "loopover-miner" } }, resolved.requestTimeoutMs);
            if (response.ok) {
                const text = await readBoundedManifestResponseText(response);
                if (typeof text === "string")
                    return text;
            }
        }
        catch {
            // Try the next candidate path.
        }
    }
    return null;
}
// Mirrors src/gittensor/api.ts's fetchGittensorContributorSnapshot/fetchOfficialGittensorMiner: a public,
// unauthenticated GET against the Gittensor API (not GitHub) -- confirmed only when a real entry with a
// matching GitHub login is found; any transport/parse failure fails closed to "not confirmed", never throws.
async function fetchConfirmedContributor(login, resolved) {
    if (!login)
        return false;
    try {
        const response = await fetchWithTimeout(resolved.fetchImpl, `${resolved.gittensorApiBase}/miners`, { method: "GET", headers: { accept: "application/json" } }, resolved.requestTimeoutMs);
        if (!response.ok)
            return false;
        const payload = await response.json().catch(() => null);
        if (!Array.isArray(payload))
            return false;
        const normalizedLogin = login.toLowerCase();
        return payload.some((miner) => typeof miner?.githubUsername === "string" && miner.githubUsername.toLowerCase() === normalizedLogin);
    }
    catch {
        return false;
    }
}
// Per self-review-adapter.ts's own doc comment: the caller computes inDuplicateCluster "the same way the
// live gate's collision report would" -- adapted from src/signals/engine.ts's real
// isPullRequestInDuplicateCluster (root src/, not extracted to the engine package), which requires >= 2
// PULL REQUEST items in a high-risk cluster, not just any high-risk cluster containing the target. That
// threshold matters: buildCollisionReport's own pairwise "shared linked issue" rule already marks an
// issue+its-one-legitimately-closing-PR pair as a HIGH-risk cluster (confirmed empirically) -- without the
// >= 2 threshold, inDuplicateCluster would fire on the completely normal case of "one PR already closes
// this issue," not genuine overlapping/duplicate work. Checks the target ISSUE's presence instead of a
// not-yet-existing PR number, since the miner's own submission doesn't exist as a real PullRequestRecord yet.
// Takes a prebuilt CollisionReport so issueQuality and inDuplicateCluster share one collision pass.
function computeInDuplicateCluster(collisionReport, targetIssueNumbers) {
    if (targetIssueNumbers.length === 0)
        return false;
    return collisionReport.clusters.some((cluster) => cluster.risk === "high" &&
        cluster.items.filter((item) => item.type === "pull_request").length >= 2 &&
        cluster.items.some((item) => item.type === "issue" && targetIssueNumbers.includes(item.number)));
}
/**
 * Build a real SelfReviewContext from live GitHub data, at the same fidelity the live gate's own DB-backed
 * construction produces. See this file's header for the one field (bounties) deliberately left undefined
 * and why; issueQuality is populated from the live GitHub snapshot. Optionally overlays ORB live gate
 * thresholds onto the static `.loopover.yml` reconstruction (#6487).
 */
export async function fetchSelfReviewContext(repoFullName, options = {}) {
    const target = parseRepoFullName(repoFullName);
    if (!target)
        throw new Error("invalid_repo_full_name");
    const resolved = normalizeOptions(options);
    const [repo, issues, pullRequests, manifestContent, confirmedContributor, liveGateThresholds] = await Promise.all([
        fetchRepositoryRecord(target, resolved),
        fetchOpenIssueRecords(target, resolved),
        fetchOpenPullRequestRecords(target, resolved),
        fetchManifestContent(target, resolved),
        fetchConfirmedContributor(resolved.contributorLogin, resolved),
        probeLiveGateThresholds(target, resolved),
    ]);
    const staticManifest = parseFocusManifestContent(manifestContent, "repo_file");
    const manifest = applyLiveGateThresholdsToManifest(staticManifest, liveGateThresholds);
    // Positional args match buildIssueQualityReport(repo, issues, pullRequests, fullName, bounties, collisions, recentMerged):
    // repo is the full RepositoryRecord from fetchRepositoryRecord (not a string); empty bounties/recentMerged
    // because this fetcher has no external bounty source and does not yet pull merge history.
    const fullName = `${target.owner}/${target.repo}`;
    const collisions = buildCollisionReport(fullName, issues, pullRequests);
    const inDuplicateCluster = computeInDuplicateCluster(collisions, resolved.linkedIssues);
    const issueQuality = buildIssueQualityReport(repo, issues, pullRequests, fullName, [], collisions, []);
    return {
        manifest,
        repo,
        issues,
        pullRequests,
        confirmedContributor,
        inDuplicateCluster,
        issueQuality,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VsZi1yZXZpZXctY29udGV4dC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNlbGYtcmV2aWV3LWNvbnRleHQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUNMLG9CQUFvQixFQUNwQix1QkFBdUIsRUFDdkIsd0JBQXdCLEVBQ3hCLHlCQUF5QixHQU0xQixNQUFNLGtCQUFrQixDQUFDO0FBQzFCLE9BQU8sRUFBRSw2QkFBNkIsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBdUo3RSxNQUFNLGtCQUFrQixHQUFHLFlBQVksQ0FBQztBQUN4QyxNQUFNLG9CQUFvQixHQUFHLHdCQUF3QixDQUFDO0FBQ3RELE1BQU0sNEJBQTRCLEdBQUcsbUNBQW1DLENBQUM7QUFDekUsTUFBTSwwQkFBMEIsR0FBRywwQkFBMEIsQ0FBQztBQUM5RCxNQUFNLGdCQUFnQixHQUFHLEdBQUcsQ0FBQztBQUM3QixNQUFNLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztBQUM3QixNQUFNLDBCQUEwQixHQUFHLE1BQU0sQ0FBQztBQUMxQyx3SEFBd0g7QUFDeEgsTUFBTSxrQ0FBa0MsR0FBRyxHQUFHLENBQUM7QUFFL0MsMEdBQTBHO0FBQzFHLDJEQUEyRDtBQUMzRCxNQUFNLHdCQUF3QixHQUFHLENBQUMsZUFBZSxFQUFFLHNCQUFzQixFQUFFLGdCQUFnQixFQUFFLHVCQUF1QixDQUFDLENBQUM7QUFFdEgsU0FBUyxpQkFBaUIsQ0FBQyxZQUFvQjtJQUM3QyxJQUFJLE9BQU8sWUFBWSxLQUFLLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNsRCxNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3JELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN4RCxPQUFPLEVBQUUsS0FB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
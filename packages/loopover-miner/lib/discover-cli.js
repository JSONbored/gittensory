/** `discover` CLI command (#4247): wires the existing fanout -> rank -> enqueue pipeline together so a miner
 * can actually run it. Every piece already exists and is independently tested; this module only composes them. */
import { resolveForgeConfig } from "./forge-config.js";
import { fetchCandidateIssuesWithSummary, searchCandidateIssuesWithSummary, } from "./opportunity-fanout.js";
import { rankCandidateIssuesWithSummary } from "./opportunity-ranker.js";
import { initPolicyDocCacheStore } from "./policy-doc-cache.js";
import { initPolicyVerdictCacheStore } from "./policy-verdict-cache.js";
import { enqueueRankedDiscovery } from "./portfolio-discovery.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initRankedCandidatesStore } from "./ranked-candidates.js";
import { extractContributionProfile } from "./contribution-profile-extract.js";
import { initContributionProfileCache } from "./contribution-profile-cache.js";
import { filterCandidatesByProfiles } from "./contribution-profile-filter.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isDiscoveryPlaneEnabled, queryDiscoveryIndex, recordDiscoveryTelemetry } from "./discovery-index-client.js";
const DISCOVER_USAGE = "Usage: loopover-miner discover <owner/repo> [<owner/repo>...] | --search <query> [--dry-run] [--json] [--api-base-url <url>] [--token-env <VAR>]";
const MAX_DISCOVER_TITLE_DISPLAY_LENGTH = 240;
const OSC_SEQUENCE_PATTERN = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const ANSI_ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function sanitizeDiscoverDisplayText(value) {
    return String(value ?? "")
        .replace(OSC_SEQUENCE_PATTERN, "")
        .replace(ANSI_ESCAPE_PATTERN, "")
        .replace(CONTROL_CHARACTER_PATTERN, " ")
        .replace(BIDI_CONTROL_PATTERN, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_DISCOVER_TITLE_DISPLAY_LENGTH);
}
function dedupeKey(repoFullName, issueNumber) {
    return `${repoFullName.toLowerCase()}#${issueNumber}`;
}
/**
 * Supplements `fanOut.issues` with hosted discovery-index results for the same scope (#7168) -- a complete
 * no-op (returns `fanOut` unchanged) unless the plane is enabled, so a run with the flag unset behaves exactly
 * as before this feature existed. Local results always win on a duplicate issue (the discovery-index candidate
 * is dropped, not merged over it) -- this instance's own live fan-out is more current than a cached shared
 * index entry. Discovery-index candidates lack `assignees` (not part of the public contract), so they're
 * annotated with an empty array to match opportunity-fanout.js's own candidate shape; contribution-profile-
 * filter.js's assignee-exclusion rule treats that identically to "no assignees on this issue".
 */
async function supplementWithDiscoveryIndex(fanOut, queryScope, options) {
    const env = options.env ?? process.env;
    if (!isDiscoveryPlaneEnabled(env))
        return fanOut;
    const queryIndex = options.queryDiscoveryIndex ?? queryDiscoveryIndex;
    const response = await queryIndex(queryScope, { env });
    recordDiscoveryTelemetry("discover_query", response.candidates.length > 0 ? "supplemented" : "empty", { env });
    if (response.candidates.length === 0)
        return fanOut;
    const seen = new Set(fanOut.issues.map((issue) => dedupeKey(issue.repoFullName, issue.issueNumber)));
    const supplemented = response.candidates
        .filter((candidate) => !seen.has(dedupeKey(candidate.repoFullName, candidate.issueNumber)))
        .map((candidate) => ({ ...candidate, assignees: [] }));
    if (supplemented.length === 0)
        return fanOut;
    return { ...fanOut, issues: [...fanOut.issues, ...supplemented] };
}
function parseRepoTarget(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
export function parseDiscoverArgs(args) {
    // `--api-base-url` and `--token-env` (#4784) thread the tenant's forge host and credential env var into the
    // fan-out; they are kept off the parsed result unless supplied, so callers that pass neither see the exact
    // pre-#4784 `{ targets, search, json }` shape.
    const options = { json: false, dryRun: false, search: null, apiBaseUrl: null, tokenEnv: null };
    const targets = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: fetches + ranks exactly as a real run, but skips opening any local store and makes zero writes.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--search") {
            const query = args[index + 1];
            if (!query || query.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.search = query;
            index += 1;
            continue;
        }
        if (token === "--api-base-url") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.apiBaseUrl = value;
            index += 1;
            continue;
        }
        if (token === "--token-env") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.tokenEnv = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        const target = parseRepoTarget(token);
        if (!target)
            return { error: `Repository must be in owner/repo form: ${token}` };
        targets.push(target);
    }
    if (options.search === null && targets.length === 0) {
        return { error: DISCOVER_USAGE };
    }
    if (options.search !== null && targets.length > 0) {
        return { error: "Pass either repository targets or --search, not both." };
    }
    return {
        targets,
        search: options.search,
        dryRun: options.dryRun,
        json: options.json,
        ...(options.apiBaseUrl !== null ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.tokenEnv !== null ? { tokenEnv: options.tokenEnv } : {}),
    };
}
// The rate-limit line surfaces the telemetry the fanout already records (#4837) so an operator sees how close a
// `discover` run is to being throttled without running a separate command. `unknown` covers the no-fetch/no-header
// case where the fanout captured no remaining count.
function renderRateLimitLine(result) {
    const remaining = result.rateLimitRemaining === null ? "unknown" : String(result.rateLimitRemaining);
    const resetSuffix = result.rateLimitResetAt === null ? "" : ` (resets ${result.rateLimitResetAt})`;
    return `rate-limit remaining: ${remaining}${resetSuffix}`;
}
export function renderDiscoverSummary(result) {
    const lines = [
        `fanned out: ${result.fanOutCount} candidate issue(s)`,
        `ai-policy warnings: ${result.warnings.length}`,
        `ranked: ${result.ranked.length}`,
        `enqueued: ${result.enqueueSummary.enqueued}`,
        renderRateLimitLine(result),
    ];
    if (result.enqueueSummary.skippedBelowMinRank > 0) {
        lines.push(`skipped (below min rank): ${result.enqueueSummary.skippedBelowMinRank}`);
    }
    // #6798: surface what the eligibility filter dropped and why, so a human sees AMS's inference.
    const excluded = result.excluded ?? [];
    if (excluded.length > 0) {
        lines.push(`excluded (eligibility): ${excluded.length}`);
        for (const entry of excluded.slice(0, 10)) {
            lines.push(`  ${entry.repoFullName}#${entry.issueNumber}  ${entry.reason}`);
        }
    }
    // Make the fall-back to loopover's built-in rubric explicit instead of silent (#4784): when no per-tenant goal
    // spec is supplied, lane fit reflects loopover's defaults, not the target repo's own conventions.
    if (result.usedDefaultGoalSpec) {
        lines.push("note: ranked with the built-in default goal spec (no per-tenant .loopover-miner.yml supplied)");
    }
    if (result.ranked.length === 0) {
        lines.push("", "no candidates found.");
        return lines.join("\n");
    }
    lines.push("", "top candidates:");
    for (const entry of result.ranked.slice(0, 10)) {
        const title = sanitizeDiscoverDisplayText(entry.title);
        lines.push(`  ${entry.repoFullName}#${entry.issueNumber}  score=${entry.rankScore.toFixed(4)}  ${title}`);
    }
    return lines.join("\n");
}
/**
 * Default per-repo ContributionProfile resolver (#6798): reads the local cache and, on a miss/stale entry,
 * extracts a fresh profile and caches it. Returns a Map keyed by repoFullName.
 *
 * WITHOUT a github token this returns an empty map and does no network work at all — AMS can't reliably read a
 * repo's label taxonomy/docs unauthenticated (rate limits), so it safe-defaults to no eligibility filtering.
 * That also keeps callers that don't supply a token (the common CLI path, and every test) hermetic.
 *
 * @param {string[]} repoFullNames unique repos among the fanned-out candidates
 * @param {{ githubToken?: string, apiBaseUrl?: string, nowMs?: number, initCache?: typeof initContributionProfileCache, extract?: typeof extractContributionProfile }} ctx
 * @returns {Promise<Map<string, object>>}
 */
export async function resolveContributionProfilesForDiscover(repoFullNames, ctx = {}) {
    const profiles = new Map();
    if (!ctx.githubToken)
        return profiles;
    const initCache = ctx.initCache ?? initContributionProfileCache;
    const extract = ctx.extract ?? extractContributionProfile;
    const cache = initCache();
    try {
        for (const repoFullName of repoFullNames) {
            const cached = cache.get(repoFullName, ctx.nowMs);
            if (cached && !cached.stale) {
                profiles.set(repoFullName, cached.profile);
                continue;
            }
            const profile = await extract(repoFullName, { githubToken: ctx.githubToken, apiBaseUrl: ctx.apiBaseUrl });
            cache.put(profile, ctx.nowMs);
            profiles.set(repoFullName, profile);
        }
    }
    finally {
        cache.close();
    }
    return profiles;
}
export async function runDiscover(args, options = {}) {
    const parsed = parseDiscoverArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    // Credential env var is per-tenant (#4784): a `--token-env FORGE_PAT` flag (or `options.tokenEnv`) reads a
    // non-`GITHUB_TOKEN` variable so a non-github.com forge's token is reachable. The default falls through to the
    // forge adapter's own `tokenEnvVar` (github.com's `GITHUB_TOKEN`), so there's a single source of truth for the
    // default credential env instead of a second hardcoded literal that could drift from `DEFAULT_FORGE_CONFIG`.
    const tokenEnv = parsed.tokenEnv ?? options.tokenEnv ?? resolveForgeConfig(options.forge).tokenEnvVar;
    const githubToken = options.githubToken ?? process.env[tokenEnv] ?? "";
    // A `--api-base-url` flag (or `options.apiBaseUrl`) surfaces the fan-out's existing forge-host override at the CLI
    // (#4784); `options.forge` carries any remaining per-tenant forge knobs for a programmatic caller.
    const apiBaseUrl = parsed.apiBaseUrl ?? options.apiBaseUrl;
    const fetchTargets = options.fetchCandidateIssuesWithSummary ?? fetchCandidateIssuesWithSummary;
    const searchTargets = options.searchCandidateIssuesWithSummary ?? searchCandidateIssuesWithSummary;
    const rankIssues = options.rankCandidateIssuesWithSummary ?? rankCandidateIssuesWithSummary;
    const enqueue = options.enqueueRankedDiscovery ?? enqueueRankedDiscovery;
    // Eligibility filtering (#6798): resolve each candidate repo's ContributionProfile and drop candidates the
    // repo's own conventions would reject, BEFORE ranking. Safe by default -- see resolveContributionProfilesForDiscover.
    const resolveProfiles = options.resolveContributionProfiles ?? resolveContributionProfilesForDiscover;
    // Same scope this run already asks GitHub about (#7168) -- the discovery-index supplement, when enabled,
    // asks the shared hosted index about the identical targets/search rather than a different query entirely.
    const discoveryQueryScope = parsed.search !== null
        ? { repos: [], orgs: [], searchTerms: [parsed.search] }
        : { repos: parsed.targets.map((target) => `${target.owner}/${target.repo}`), orgs: [], searchTerms: [] };
    // #4847: fetch + rank are read-only GitHub GETs and pure local computation, so a dry run still does them for
    // real (that's the useful "what would this discover?" output) -- but it never opens any local store (portfolio
    // queue, policy-doc cache, policy-verdict cache), since opening a not-yet-existing SQLite store file is itself
    // a write. The ranked issues are fed through a no-op queue stub so enqueueRankedDiscovery's own classification
    // logic (valid/invalid, below-min-rank) still runs for real, just without ever touching the real queue.
    if (parsed.dryRun) {
        const fanOutOptions = { apiBaseUrl, forge: options.forge, policyDocCache: null, policyVerdictCache: null };
        try {
            let fanOut = parsed.search !== null
                ? await searchTargets(parsed.search, githubToken, fanOutOptions)
                : await fetchTargets(parsed.targets, githubToken, fanOutOptions);
            fanOut = await supplementWithDiscoveryIndex(fanOut, discoveryQueryScope, options);
            // #6798: same eligibility filter as the real path, so a dry run shows the exact candidate set a real run
            // would enqueue (and the same excluded set), rather than an unfiltered preview.
            const repoFullNames = [...new Set(fanOut.issues.map((issue) => issue.repoFullName))];
            const profilesByRepo = await resolveProfiles(repoFullNames, { githubToken, apiBaseUrl, nowMs: options.nowMs });
            const { kept, excluded } = filterCandidatesByProfiles(fanOut.issues, profilesByRepo);
            const rankedSummary = rankIssues(kept, {
                nowMs: options.nowMs,
                goalSpecsByRepo: options.goalSpecsByRepo,
                goalSpecContentByRepo: options.goalSpecContentByRepo,
            });
            const noopQueueStore = { enqueue: () => { } };
            const enqueueSummary = enqueue(rankedSummary.issues, { queueStore: noopQueueStore });
            const result = {
                outcome: "dry_run",
                fanOutCount: fanOut.issues.length,
                warnings: fanOut.warnings,
                rateLimitRemaining: fanOut.rateLimitRemaining,
                rateLimitResetAt: fanOut.rateLimitResetAt,
                ranked: rankedSummary.issues,
                excluded: excluded.map((entry) => ({
                    repoFullName: entry.candidate.repoFullName,
                    issueNumber: entry.candidate.issueNumber,
                    reason: entry.reason,
                })),
                usedDefaultGoalSpec: rankedSummary.usedDefaultGoalSpec,
                enqueueSummary,
            };
            // Structured-outcome hook (#6522), mirroring runAttempt's onResult convention: fires only at a real
            // structured success point (never the reportCliFailure branches), in addition to -- never instead of --
            // the plain exit-code return, so a non-CLI caller (the /api/discover route) can read the result.
            options.onResult?.(result);
            if (parsed.json) {
                console.log(JSON.stringify(result, null, 2));
            }
            else {
                console.log(renderDiscoverSummary(result));
                console.log("\nDRY RUN: no portfolio-queue write was made.");
            }
            return 0;
        }
        catch (error) {
            return reportCliFailure(parsed.json, describeCliError(error));
        }
    }
    const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
    let portfolioQueue;
    try {
        portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    // Local ETag cache so a repeated discover revalidates each repo's policy docs with a conditional GET instead of
    // re-downloading them (#4842). Opened inside its OWN try/catch, separate from the portfolio queue above: the
    // queue is required infrastructure (discovery genuinely cannot enqueue anything without it, so a real open
    // failure should abort the run), but the policy-doc cache is a pure performance optimization -- a corrupt or
    // unwritable cache DB must degrade to "no cache" (every doc fetched in full, exactly as before #4842) rather
    // than fail discovery outright.
    let policyDocCache = null;
    let ownsPolicyDocCache = false;
    try {
        ownsPolicyDocCache = options.initPolicyDocCache === undefined;
        policyDocCache = (options.initPolicyDocCache ?? initPolicyDocCacheStore)();
    }
    catch {
        policyDocCache = null;
        ownsPolicyDocCache = false;
    }
    // Persisted cache of resolved policy verdicts (#4843), same "own try/catch, degrade to null" discipline as the
    // doc cache above and for the same reason: purely a performance optimization the feature is inert without, so a
    // corrupt/unwritable cache DB must never abort a run.
    let policyVerdictCache = null;
    let ownsPolicyVerdictCache = false;
    try {
        ownsPolicyVerdictCache = options.initPolicyVerdictCache === undefined;
        policyVerdictCache = (options.initPolicyVerdictCache ?? initPolicyVerdictCacheStore)();
    }
    catch {
        policyVerdictCache = null;
        ownsPolicyVerdictCache = false;
    }
    // Snapshot of this run's full ranked output (#4859 prerequisite), so a local HTTP endpoint (and eventually the
    // miner-ui/browser-extension live-fetch it's meant for) can serve the same per-issue breakdown `--json` prints,
    // without the operator re-running discover or hand-pasting its output. Same "own try/catch, degrade to null"
    // discipline as the two caches above: a corrupt/unwritable snapshot store must never abort discovery's actual
    // job (fan out, rank, enqueue). Unlike the caches, this store is a WRITE target, not a read optimization -- the
    // save call itself gets its own try/catch below for the same reason.
    let rankedCandidatesStore = null;
    let ownsRankedCandidatesStore = false;
    try {
        ownsRankedCandidatesStore = options.initRankedCandidatesStore === undefined;
        rankedCandidatesStore = (options.initRankedCandidatesStore ?? initRankedCandidatesStore)();
    }
    catch {
        rankedCandidatesStore = null;
        ownsRankedCandidatesStore = false;
    }
    const fanOutOptions = { apiBaseUrl, forge: options.forge, policyDocCache, policyVerdictCache };
    try {
        let fanOut = parsed.search !== null
            ? await searchTargets(parsed.search, githubToken, fanOutOptions)
            : await fetchTargets(parsed.targets, githubToken, fanOutOptions);
        fanOut = await supplementWithDiscoveryIndex(fanOut, discoveryQueryScope, options);
        // Eligibility filter (#6798): drop candidates a target repo's own conventions would reject, before ranking.
        // A repo with no trustworthy eligibility profile keeps every candidate (filterCandidatesByProfiles' safe
        // default), so this never silently skips real work on a repo whose conventions AMS couldn't read.
        const repoFullNames = [...new Set(fanOut.issues.map((issue) => issue.repoFullName))];
        const profilesByRepo = await resolveProfiles(repoFullNames, { githubToken, apiBaseUrl, nowMs: options.nowMs });
        const { kept, excluded } = filterCandidatesByProfiles(fanOut.issues, profilesByRepo);
        // Pass any caller-supplied per-tenant goal specs through to the ranker so lane fit uses the tenant's
        // conventions instead of silently falling back to loopover's defaults (#4784); the fallback is surfaced via
        // `usedDefaultGoalSpec` below rather than hidden.
        const rankedSummary = rankIssues(kept, {
            nowMs: options.nowMs,
            goalSpecsByRepo: options.goalSpecsByRepo,
            goalSpecContentByRepo: options.goalSpecContentByRepo,
        });
        const enqueueSummary = enqueue(rankedSummary.issues, { queueStore: portfolioQueue, apiBaseUrl });
        try {
            // Optional chaining rather than an `if (rankedCandidatesStore)` guard: a null store (open failed above)
            // short-circuits to a no-op read, so the same try/catch below also covers the open-failed case without a
            // second explicit branch.
            rankedCandidatesStore?.saveRankedCandidates(rankedSummary.issues, options.nowMs);
        }
        catch {
            // Non-fatal: the ranked-candidates snapshot is a nice-to-have for the local HTTP endpoint, not a
            // requirement for discover's own job (fan out, rank, enqueue), which already succeeded above.
        }
        const result = {
            fanOutCount: fanOut.issues.length,
            warnings: fanOut.warnings,
            rateLimitRemaining: fanOut.rateLimitRemaining,
            rateLimitResetAt: fanOut.rateLimitResetAt,
            ranked: rankedSummary.issues,
            // #6798: candidates the eligibility filter dropped, each with the repo + issue + reason, so a human sees
            // what AMS inferred and why a candidate was skipped. Empty when no profile was trustworthy enough to filter.
            excluded: excluded.map((entry) => ({
                repoFullName: entry.candidate.repoFullName,
                issueNumber: entry.candidate.issueNumber,
                reason: entry.reason,
            })),
            usedDefaultGoalSpec: rankedSummary.usedDefaultGoalSpec,
            enqueueSummary,
        };
        // Structured-outcome hook (#6522) for the full-run success point -- same convention as the dry-run branch
        // above and as runAttempt's onResult: real result only, additive to the unchanged exit-code return.
        options.onResult?.(result);
        if (parsed.json) {
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            console.log(renderDiscoverSummary(result));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        if (ownsPortfolioQueue && portfolioQueue)
            portfolioQueue.close();
        if (ownsPolicyDocCache && policyDocCache)
            policyDocCache.close();
        if (ownsPolicyVerdictCache && policyVerdictCache)
            policyVerdictCache.close();
        if (ownsRankedCandidatesStore && rankedCandidatesStore)
            rankedCandidatesStore.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlzY292ZXItY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGlzY292ZXItY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO2tIQUNrSDtBQUNsSCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUN2RCxPQUFPLEVBQ0wsK0JBQStCLEVBQy9CLGdDQUFnQyxHQUNqQyxNQUFNLHlCQUF5QixDQUFDO0FBT2pDLE9BQU8sRUFBRSw4QkFBOEIsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBTXpFLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBRWhFLE9BQU8sRUFBRSwyQkFBMkIsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBRXhFLE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBRWxFLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRS9ELE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBRW5FLE9BQU8sRUFBRSwwQkFBMEIsRUFBRSxNQUFNLG1DQUFtQyxDQUFDO0FBQy9FLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxNQUFNLGlDQUFpQyxDQUFDO0FBQy9FLE9BQU8sRUFBRSwwQkFBMEIsRUFBRSxNQUFNLGtDQUFrQyxDQUFDO0FBQzlFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsdUJBQXVCLEVBQUUsbUJBQW1CLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQWtHckgsTUFBTSxjQUFjLEdBQ2xCLGtKQUFrSixDQUFDO0FBRXJKLE1BQU0saUNBQWlDLEdBQUcsR0FBRyxDQUFDO0FBQzlDLE1BQU0sb0JBQW9CLEdBQUcsc0NBQXNDLENBQUM7QUFDcEUsTUFBTSxtQkFBbUIsR0FBRyxzQ0FBc0MsQ0FB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
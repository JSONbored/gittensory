import { DEFAULT_MINER_GOAL_SPEC, parseMinerGoalSpecContent, rankMetadataOpportunities, } from "@loopover/engine";
function finiteEpochMs(value) {
    return Number.isFinite(value) ? value : Date.now();
}
function finiteNonNegativeInt(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.floor(value));
}
function normalizeCandidate(candidate) {
    if (!candidate || typeof candidate !== "object")
        return null;
    const c = candidate;
    const repoFullName = typeof c.repoFullName === "string" ? c.repoFullName.trim() : "";
    const issueNumber = c.issueNumber;
    const title = typeof c.title === "string" ? c.title.trim() : "";
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !title)
        return null;
    const canonicalRepoFullName = `${owner}/${repo}`;
    const labels = Array.isArray(c.labels)
        ? c.labels
            .filter((label) => typeof label === "string" && label.trim())
            .map((label) => label.trim())
        : [];
    return {
        owner,
        repo,
        repoFullName: canonicalRepoFullName,
        issueNumber: issueNumber,
        title,
        labels,
        commentsCount: Number.isFinite(c.commentsCount) ? c.commentsCount : 0,
        createdAt: typeof c.createdAt === "string" ? c.createdAt : null,
        updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : null,
        htmlUrl: typeof c.htmlUrl === "string" ? c.htmlUrl : null,
        aiPolicyAllowed: c.aiPolicyAllowed !== false,
        aiPolicySource: c.aiPolicySource === "AI-USAGE.md" ||
            c.aiPolicySource === "CONTRIBUTING.md" ||
            c.aiPolicySource === "none"
            ? c.aiPolicySource
            : "none",
    };
}
function buildGoalSpecsByRepo(options = {}) {
    const goalSpecsByRepo = { ...(options.goalSpecsByRepo ?? {}) };
    const rawContentByRepo = options.goalSpecContentByRepo ?? {};
    for (const [repoFullName, content] of Object.entries(rawContentByRepo)) {
        if (typeof content !== "string" || !content.trim())
            continue;
        goalSpecsByRepo[repoFullName] = parseMinerGoalSpecContent(content).spec;
    }
    return goalSpecsByRepo;
}
function buildRankContext(options = {}) {
    return {
        nowMs: finiteEpochMs(options.nowMs),
        highRiskDuplicateClusters: finiteNonNegativeInt(options.highRiskDuplicateClusters),
        openPullRequests: finiteNonNegativeInt(options.openPullRequests),
        goalSpecsByRepo: buildGoalSpecsByRepo(options),
    };
}
function collectCandidates(candidates) {
    const input = Array.isArray(candidates) ? candidates : [];
    let skippedInvalid = 0;
    const normalized = [];
    const seen = new Set();
    for (const candidate of input) {
        const entry = normalizeCandidate(candidate);
        if (!entry) {
            skippedInvalid += 1;
            continue;
        }
        const key = `${entry.repoFullName.toLowerCase()}#${entry.issueNumber}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        normalized.push(entry);
    }
    return { normalized, skippedInvalid };
}
function rankedUsesDefaultGoalSpec(ranked, options = {}) {
    const goalSpecsByRepo = buildGoalSpecsByRepo(options);
    const specRepos = Object.keys(goalSpecsByRepo);
    if (ranked.length === 0)
        return specRepos.length === 0;
    // The "ranked with the built-in default goal spec (no per-tenant .loopover-miner.yml supplied)" note is only
    // truthful when the WHOLE batch fell back to the default -- so require EVERY ranked repo to lack a supplied spec,
    // not just any one of them (#7226). With `.some`, a single spec-less repo made a mixed batch (where other repos
    // genuinely had a spec supplied and applied) print the blanket note as if none did.
    return ranked.every((issue) => {
        const target = issue.repoFullName.trim().toLowerCase();
        return !specRepos.some((repo) => repo.trim().toLowerCase() === target);
    });
}
/**
 * Rank metadata-only fan-out candidates locally. Never clones source, never uploads metadata, and never writes to
 * GitHub — it only composes deterministic engine signals and returns the sorted list.
 */
export function rankCandidateIssues(candidates, options = {}) {
    const { normalized } = collectCandidates(candidates);
    return rankMetadataOpportunities(normalized, buildRankContext(options));
}
export function rankCandidateIssuesWithSummary(candidates, options = {}) {
    const { normalized, skippedInvalid } = collectCandidates(candidates);
    const ranked = rankMetadataOpportunities(normalized, buildRankContext(options));
    return {
        issues: ranked,
        skippedInvalid,
        usedDefaultGoalSpec: rankedUsesDefaultGoalSpec(ranked, options),
        defaultGoalSpec: DEFAULT_MINER_GOAL_SPEC,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3Bwb3J0dW5pdHktcmFua2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsib3Bwb3J0dW5pdHktcmFua2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFDTCx1QkFBdUIsRUFDdkIseUJBQXlCLEVBQ3pCLHlCQUF5QixHQUMxQixNQUFNLGtCQUFrQixDQUFDO0FBNkMxQixTQUFTLGFBQWEsQ0FBQyxLQUF5QjtJQUM5QyxPQUFPLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFFLEtBQWdCLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUNqRSxDQUFDO0FBRUQsU0FBUyxvQkFBb0IsQ0FBQyxLQUF5QjtJQUNyRCxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUM7UUFBRSxPQUFPLENBQUMsQ0FBQztJQUN0QyxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBZSxDQUFDLENBQUMsQ0FBQztBQUNsRCxDQUFDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxTQUFrQjtJQUM1QyxJQUFJLENBQUMsU0FBUyxJQUFJLE9BQU8sU0FBUyxLQUFLLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUM3RCxNQUFNLENBQUMsR0FBRyxTQUFvQyxDQUFDO0lBQy9DLE1BQU0sWUFBWSxHQUNoQixPQUFPLENBQUMsQ0FBQyxZQUFZLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDbEUsTUFBTSxXQUFXLEdBQUcsQ0FBQyxDQUFDLFdBQVcsQ0FBQztJQUNsQyxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsQ0FBQyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksRUFB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
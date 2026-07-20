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
    const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
    const issueNumber = candidate.issueNumber;
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !title)
        return null;
    const canonicalRepoFullName = `${owner}/${repo}`;
    const labels = Array.isArray(candidate.labels)
        ? candidate.labels
            .filter((label) => typeof label === "string" && label.trim())
            .map((label) => label.trim())
        : [];
    return {
        owner,
        repo,
        repoFullName: canonicalRepoFullName,
        issueNumber,
        title,
        labels,
        commentsCount: Number.isFinite(candidate.commentsCount) ? candidate.commentsCount : 0,
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : null,
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
        htmlUrl: typeof candidate.htmlUrl === "string" ? candidate.htmlUrl : null,
        aiPolicyAllowed: candidate.aiPolicyAllowed !== false,
        aiPolicySource: candidate.aiPolicySource === "AI-USAGE.md" ||
            candidate.aiPolicySource === "CONTRIBUTING.md" ||
            candidate.aiPolicySource === "none"
            ? candidate.aiPolicySource
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3Bwb3J0dW5pdHktcmFua2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsib3Bwb3J0dW5pdHktcmFua2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFDTCx1QkFBdUIsRUFDdkIseUJBQXlCLEVBQ3pCLHlCQUF5QixHQUMxQixNQUFNLGtCQUFrQixDQUFDO0FBNEIxQixTQUFTLGFBQWEsQ0FBQyxLQUFjO0lBQ25DLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUUsS0FBZ0IsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBQ2pFLENBQUM7QUFFRCxTQUFTLG9CQUFvQixDQUFDLEtBQWM7SUFDMUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxDQUFDLENBQUM7SUFDdEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQWUsQ0FBQyxDQUFDLENBQUM7QUFDbEQsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsU0FBa0M7SUFDNUQsSUFBSSxDQUFDLFNBQVMsSUFBSSxPQUFPLFNBQVMsS0FBSyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDN0QsTUFBTSxZQUFZLEdBQ2hCLE9BQU8sU0FBUyxDQUFDLFlBQVksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUNsRixNQUFNLFdBQVcsR0FBRyxTQUFTLENBQUMsV0FBcUIsQ0FBQztJQUNwRCxNQUFNLEtBQUssR0FBRyxPQUFPLFNBQVMsQ0FBQyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDaEYs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
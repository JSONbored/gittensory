function normalizeMinRankScore(minRankScore) {
    if (minRankScore === undefined || minRankScore === null)
        return 0;
    if (typeof minRankScore !== "number" || !Number.isFinite(minRankScore) || minRankScore < 0) {
        throw new Error("invalid_min_rank_score");
    }
    return minRankScore;
}
function normalizeRankedIssue(issue) {
    if (!issue || typeof issue !== "object")
        return null;
    const i = issue;
    const repoFullName = typeof i.repoFullName === "string" ? i.repoFullName.trim() : "";
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    if (!Number.isInteger(i.issueNumber) || i.issueNumber <= 0)
        return null;
    if (typeof i.rankScore !== "number" || !Number.isFinite(i.rankScore) || i.rankScore < 0) {
        return null;
    }
    const title = typeof i.title === "string" ? i.title.trim() : "";
    if (!title)
        return null;
    const labels = Array.isArray(i.labels)
        ? i.labels.filter((label) => typeof label === "string" && label.trim() !== "").map((label) => label.trim())
        : [];
    return {
        repoFullName: `${owner}/${repo}`,
        issueNumber: i.issueNumber,
        title,
        labels,
        rankScore: i.rankScore,
    };
}
/**
 * Enqueue ranked discovery rows into the local portfolio backlog. Uses each row's `rankScore` as queue priority
 * (the #2292 placeholder field). Optionally appends `discovered_issue` audit events when an event ledger is supplied.
 * Never calls GitHub — callers rank locally first via `rankCandidateIssues`.
 */
export function enqueueRankedDiscovery(rankedIssues, options) {
    if (!Array.isArray(rankedIssues))
        throw new Error("invalid_ranked_issues");
    const queueStore = options.queueStore;
    if (!queueStore || typeof queueStore.enqueue !== "function")
        throw new Error("invalid_queue_store");
    let eventLedger = null;
    if (options.eventLedger !== undefined) {
        eventLedger = options.eventLedger;
        if (!eventLedger || typeof eventLedger.appendEvent !== "function") {
            throw new Error("invalid_event_ledger");
        }
    }
    const minRankScore = normalizeMinRankScore(options.minRankScore);
    // #5563: threaded through from the caller's already-resolved forge host, so a non-default (GitHub Enterprise)
    // tenant's ranked issues land in the queue scoped to their own host instead of colliding with a same-named
    // owner/repo on github.com. Omitted/nullish falls through to the queue store's own github.com default.
    const apiBaseUrl = options.apiBaseUrl;
    const summary = {
        enqueued: 0,
        skippedBelowMinRank: 0,
        skippedInvalid: 0,
        eventsAppended: 0,
    };
    for (const issue of rankedIssues) {
        const normalized = normalizeRankedIssue(issue);
        if (!normalized) {
            summary.skippedInvalid += 1;
            continue;
        }
        if (normalized.rankScore < minRankScore) {
            summary.skippedBelowMinRank += 1;
            continue;
        }
        // Spread-omit rather than pass `undefined` explicitly -- EnqueueItem's `apiBaseUrl` doesn't declare
        // `| undefined`, and exactOptionalPropertyTypes treats those as different.
        queueStore.enqueue({
            repoFullName: normalized.repoFullName,
            identifier: `issue:${normalized.issueNumber}`,
            priority: normalized.rankScore,
            ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
        });
        summary.enqueued += 1;
        if (eventLedger) {
            eventLedger.appendEvent({
                type: "discovered_issue",
                repoFullName: normalized.repoFullName,
                payload: {
                    issueNumber: normalized.issueNumber,
                    rankScore: normalized.rankScore,
                    title: normalized.title,
                    labels: normalized.labels,
                },
            });
            summary.eventsAppended += 1;
        }
    }
    return summary;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9ydGZvbGlvLWRpc2NvdmVyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBvcnRmb2xpby1kaXNjb3ZlcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBa0NBLFNBQVMscUJBQXFCLENBQUMsWUFBdUM7SUFDcEUsSUFBSSxZQUFZLEtBQUssU0FBUyxJQUFJLFlBQVksS0FBSyxJQUFJO1FBQUUsT0FBTyxDQUFDLENBQUM7SUFDbEUsSUFBSSxPQUFPLFlBQVksS0FBSyxRQUFRLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxJQUFJLFlBQVksR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUMzRixNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUNELE9BQU8sWUFBWSxDQUFDO0FBQ3RCLENBQUM7QUFFRCxTQUFTLG9CQUFvQixDQUFDLEtBQWM7SUFDMUMsSUFBSSxDQUFDLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDckQsTUFBTSxDQUFDLEdBQUcsS0FBZ0MsQ0FBQztJQUMzQyxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsQ0FBQyxZQUFZLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDckYsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsWUFBWSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNyRCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxJQUFLLENBQUMsQ0FBQyxXQUFzQixJQUFJLENBQUM7UUFB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
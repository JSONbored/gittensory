import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
const defaultDbFileName = "ranked-candidates.sqlite3";
let defaultRankedCandidatesStore = null;
export function resolveRankedCandidatesDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_RANKED_CANDIDATES_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveRankedCandidatesDbPath(), "invalid_ranked_candidates_db_path");
}
function normalizeFiniteRankDimension(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}
function normalizeCandidate(candidate) {
    if (!candidate || typeof candidate !== "object")
        throw new Error("invalid_ranked_candidate");
    const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_ranked_candidate");
    const issueNumber = candidate.issueNumber;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0)
        throw new Error("invalid_ranked_candidate");
    const rankScore = Number(candidate.rankScore);
    if (!Number.isFinite(rankScore))
        throw new Error("invalid_ranked_candidate");
    return {
        repoFullName: `${owner}/${repo}`,
        issueNumber,
        title: typeof candidate.title === "string" ? candidate.title : "",
        htmlUrl: typeof candidate.htmlUrl === "string" ? candidate.htmlUrl : null,
        rankScore,
        // A dimension the ranker didn't supply degrades to the SAME neutral defaults opportunity-ranker.js's own
        // normalizeCandidate uses for a missing signal (0 for a benefit dimension, 1 -- max risk -- for dupRisk),
        // rather than silently coercing a non-finite value to 0 across the board.
        laneFit: normalizeFiniteRankDimension(candidate.laneFit, 0),
        freshness: normalizeFiniteRankDimension(candidate.freshness, 0),
        potential: normalizeFiniteRankDimension(candidate.potential, 0),
        feasibility: normalizeFiniteRankDimension(candidate.feasibility, 0),
        dupRisk: normalizeFiniteRankDimension(candidate.dupRisk, 1),
    };
}
function rowToCandidate(row) {
    return {
        repoFullName: row.repo_full_name,
        issueNumber: row.issue_number,
        title: row.title,
        htmlUrl: row.html_url,
        rankScore: row.rank_score,
        laneFit: row.lane_fit,
        freshness: row.freshness,
        potential: row.potential,
        feasibility: row.feasibility,
        dupRisk: row.dup_risk,
        rankedAt: row.ranked_at,
    };
}
function asRankedCandidateDbRow(row) {
    return row;
}
/**
 * Opens the 100% local/client-side ranked-candidates snapshot store. The database only lives on this machine;
 * this module never uploads, syncs, or phones home with its contents.
 */
export function initRankedCandidatesStore(dbPath = resolveRankedCandidatesDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const db = openLocalStoreDb(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS miner_ranked_candidates (
      repo_full_name TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      html_url TEXT,
      rank_score REAL NOT NULL,
      lane_fit REAL NOT NULL,
      freshness REAL NOT NULL,
      potential REAL NOT NULL,
      feasibility REAL NOT NULL,
      dup_risk REAL NOT NULL,
      ranked_at TEXT NOT NULL,
      PRIMARY KEY (repo_full_name, issue_number)
    )
  `);
    // Schema-version convention (#4832): stamp the baseline. No post-baseline migrations yet -- this is a new store.
    applySchemaMigrations(db, []);
    const deleteAllStatement = db.prepare("DELETE FROM miner_ranked_candidates");
    const insertStatement = db.prepare(`
    INSERT INTO miner_ranked_candidates
      (repo_full_name, issue_number, title, html_url, rank_score, lane_fit, freshness, potential, feasibility, dup_risk, ranked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const listStatement = db.prepare("SELECT * FROM miner_ranked_candidates ORDER BY rank_score DESC");
    // Atomic replace: a reader between the DELETE and the INSERTs must never observe an empty table mid-write.
    // node:sqlite's DatabaseSync has no `.transaction()` helper (unlike better-sqlite3) -- mirrors
    // portfolio-queue.js's batchClaim: explicit BEGIN IMMEDIATE/COMMIT, ROLLBACK + rethrow on failure.
    function replaceAll(normalizedCandidates, rankedAt) {
        db.exec("BEGIN IMMEDIATE");
        try {
            deleteAllStatement.run();
            for (const candidate of normalizedCandidates) {
                insertStatement.run(candidate.repoFullName, candidate.issueNumber, candidate.title, candidate.htmlUrl, candidate.rankScore, candidate.laneFit, candidate.freshness, candidate.potential, candidate.feasibility, candidate.dupRisk, rankedAt);
            }
            db.exec("COMMIT");
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }
    return {
        dbPath: resolvedPath,
        /** Replaces the whole snapshot wholesale with this run's ranked candidates. `nowMs` is caller-supplied
         *  (never reads the clock internally) so tests get a deterministic `rankedAt`. */
        saveRankedCandidates(candidates, nowMs) {
            const normalized = (Array.isArray(candidates) ? candidates : []).map(normalizeCandidate);
            const rankedAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
            replaceAll(normalized, rankedAt);
            return { count: normalized.length, rankedAt };
        },
        /** Every candidate from the last saved run, highest rankScore first. Empty (not an error) before any
         *  discover run has ever saved a snapshot, or if the last run found zero candidates. */
        listRankedCandidates() {
            return listStatement.all().map((row) => rowToCandidate(asRankedCandidateDbRow(row)));
        },
        close() {
            db.close();
        },
    };
}
function getDefaultRankedCandidatesStore() {
    defaultRankedCandidatesStore ??= initRankedCandidatesStore();
    return defaultRankedCandidatesStore;
}
export function saveRankedCandidates(candidates, nowMs) {
    return getDefaultRankedCandidatesStore().saveRankedCandidates(candidates, nowMs);
}
export function listRankedCandidates() {
    return getDefaultRankedCandidatesStore().listRankedCandidates();
}
export function closeDefaultRankedCandidatesStore() {
    if (!defaultRankedCandidatesStore)
        return;
    defaultRankedCandidatesStore.close();
    defaultRankedCandidatesStore = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmFua2VkLWNhbmRpZGF0ZXMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyYW5rZWQtY2FuZGlkYXRlcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEVBQUUseUJBQXlCLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUN4RyxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQXNGNUQsTUFBTSxpQkFBaUIsR0FBRywyQkFBMkIsQ0FBQztBQUN0RCxJQUFJLDRCQUE0QixHQUFpQyxJQUFJLENBQUM7QUFFdEUsTUFBTSxVQUFVLDZCQUE2QixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQ2pHLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUscUNBQXFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDaEcsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWM7SUFDckMsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsNkJBQTZCLEVBQUUsRUFBRSxtQ0FBbUMsQ0FBQyxDQUFDO0FBQ2pILENBQUM7QUFFRCxTQUFTLDRCQUE0QixDQUFDLEtBQWMsRUFBRSxRQUFnQjtJQUNwRSxPQUFPLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFFLEtBQWdCLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUMvRCxDQUFDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxTQUErQjtJQUN6RCxJQUFJLENBQUMsU0FBUyxJQUFJLE9BQU8sU0FBUyxLQUFLLFFBQVE7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLDBCQUEwQixDQUFDLENBQUM7SUFDN0YsTUFBTSxZQUFZLEdBQUcsT0FBTyxTQUFTLENBQUMsWUFBWSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3JHLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDckQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsMEJBQTBCLENBQUMsQ0FBQztJQUN4RixNQUFNLFdBQVcsR0FBRyxTQUFTLENBQUMsV0FBVyxDQUFDO0lBQzFDLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxJQUFJLFdBQVcsSUFBSSxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQ3BHLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDOUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQzdFLE9BQU87UUFDTCxZQUFZLEVBQUUsR0FBRyxLQUFLLElBQUksSUFBSSxFQUFFO1FBQ2hDLFdBQVc7UUFDWCxLQUFLLEVBQUUsT0FBTyxTQUFTLENBQUMsS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRTtRQUNqRSxPQUFPLEVBQUUsT0FBTyxTQUFTLENBQUMsT0FBTyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSTtRQUN6RSxTQUFTO1FBQ1QseUdBQXlHO1FBQ3pHLDBHQUEwRztRQUMxRywwRUFBMEU7UUFDMUUsT0FBTyxFQUFFLDRCQUE0QixDQUFDLFNBQVMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQzNELFNBQVMsRUFBRSw0QkFBNEIsQ0FBQyxTQUFTLENBQUMsU0FBUyxFQUFFLENBQUMsQ0FBQztRQUMvRCxTQUFTLEVBQUUsNEJBQTRCLENBQUMsU0FBUyxDQUFDLFNBQVMsRUFBRSxDQUFDLENBQUM7UUFDL0QsV0FBVyxFQUFFLDRCQUE0QixDQUFDLFNBQVMsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxDQUFDO1FBQ25FLE9BQU8sRUFBRSw0QkFBNEIsQ0FBQyxTQUFTLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztLQUM1RCxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsY0FBYyxDQUFDLEdBQXlCO0lBQy9DLE9BQU87UUFDTCxZQUFZLEVBQUUsR0FBRyxDQUFDLGNBQWM7UUFDaEMsV0FBVyxFQUFFLEdBQUcsQ0FBQyxZQUFZO1FBQzdCLEtBQUssRUFBRSxHQUFHLENBQUMsS0FBSztRQUNoQixPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVE7UUFDckIsU0FBUyxFQUFFLEdBQUcsQ0FBQyxVQUFVO1FBQ3pCLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUTtRQUNyQixTQUFTLEVBQUUsR0FBRyxDQUFDLFNBQVM7UUFDeEIsU0FBUyxFQUFFLEdBQUcsQ0FBQyxTQUFTO1FBQ3hCLFdBQVcsRUFBRSxHQUFHLENBQUMsV0FBVztRQUM1QixPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVE7UUFDckIsUUFBUSxFQUFFLEdBQUcsQ0FBQyxTQUFTO0tBQ3hCLENBQUM7QUFDSixDQUFDO0FBRUQsU0FBUyxzQkFBc0IsQ0FBQyxHQUFtQztJQUNqRSxPQUFPLEdBQXNDLENBQUM7QUFDaEQsQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSx5QkFBeUIsQ0FBQyxTQUFpQiw2QkFBNkIsRUFBRTtJQUN4RixNQUFNLFlBQVksR0FBRyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDN0MsTUFBTSxFQUFFLEdBQUcsZ0JBQWdCLENBQUMsWUFBWSxDQUFDLENBQUM7SUFDMUMsRUFBRSxDQUFDLElBQUksQ0FBQzs7Ozs7Ozs7Ozs7Ozs7O0dBZVAsQ0FBQyxDQUFDO0lBQ0gsaUhBQWlIO0lBQ2pILHFCQUFxQixDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUU5QixNQUFNLGtCQUFrQixHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMscUNBQXFDLENBQUMsQ0FBQztJQUM3RSxNQUFNLGVBQWUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDOzs7O0dBSWxDLENBQUMsQ0FBQztJQUNILE1BQU0sYUFBYSxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsZ0VBQWdFLENBQUMsQ0FBQztJQUVuRywyR0FBMkc7SUFDM0csK0ZBQStGO0lBQy9GLG1HQUFtRztJQUNuRyxTQUFTLFVBQVUsQ0FBQyxvQkFBaUQsRUFBRSxRQUFnQjtRQUNyRixFQUFFLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDM0IsSUFBSSxDQUFDO1lBQ0gsa0JBQWtCLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDekIsS0FBSyxNQUFNLFNBQVMsSUFBSSxvQkFBb0IsRUFBRSxDQUFDO2dCQUM3QyxlQUFlLENBQUMsR0FBRyxDQUNqQixTQUFTLENBQUMsWUFBWSxFQUN0QixTQUFTLENBQUMsV0FBVyxFQUNyQixTQUFTLENBQUMsS0FBSyxFQUNmLFNBQVMsQ0FBQyxPQUFPLEVBQ2pCLFNBQVMsQ0FBQyxTQUFTLEVBQ25CLFNBQVMsQ0FBQyxPQUFPLEVBQ2pCLFNBQVMsQ0FBQyxTQUFTLEVBQ25CLFNBQVMsQ0FBQyxTQUFTLEVBQ25CLFNBQVMsQ0FBQyxXQUFXLEVBQ3JCLFNBQVMsQ0FBQyxPQUFPLEVBQ2pCLFFBQVEsQ0FDVCxDQUFDO1lBQ0osQ0FBQztZQUNELEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDcEIsQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDZixFQUFFLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxDQUFDO1FBQ2QsQ0FBQztJQUNILENBQUM7SUFFRCxPQUFPO1FBQ0wsTUFBTSxFQUFFLFlBQVk7UUFDcEI7MEZBQ2tGO1FBQ2xGLG9CQUFvQixDQUFDLFVBQVUsRUFBRSxLQUFLO1lBQ3BDLE1BQU0sVUFBVSxHQUFHLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsa0JBQWtCLENBQUMsQ0FBQztZQUN6RixNQUFNLFFBQVEsR0FBRyxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBRSxLQUFnQixDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNqRyxVQUFVLENBQUMsVUFBVSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ2pDLE9BQU8sRUFBRSxLQUFLLEVBQUUsVUFBVSxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUUsQ0FBQztRQUNoRCxDQUFDO1FBQ0Q7Z0dBQ3dGO1FBQ3hGLG9CQUFvQjtZQUNsQixPQUFPLGFBQWEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLGNBQWMsQ0FBQyxzQkFBc0IsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDdkYsQ0FBQztRQUNELEtBQUs7WUFDSCxFQUFFLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDYixDQUFDO0tBQ0YsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLCtCQUErQjtJQUN0Qyw0QkFBNEIsS0FBSyx5QkFBeUIsRUFBRSxDQUFDO0lBQzdELE9BQU8sNEJBQTRCLENBQUM7QUFDdEMsQ0FBQztBQUVELE1BQU0sVUFBVSxvQkFBb0IsQ0FBQyxVQUFrQyxFQUFFLEtBQWM7SUFDckYsT0FBTywrQkFBK0IsRUFBRSxDQUFDLG9CQUFvQixDQUFDLFVBQVUsRUFBRSxLQUFLLENBQUMsQ0FBQztBQUNuRixDQUFDO0FBRUQsTUFBTSxVQUFVLG9CQUFvQjtJQUNsQyxPQUFPLCtCQUErQixFQUFFLENBQUMsb0JBQW9CLEVBQUUsQ0FBQztBQUNsRSxDQUFDO0FBRUQsTUFBTSxVQUFVLGlDQUFpQztJQUMvQyxJQUFJLENBQUMsNEJBQTRCO1FBQUUsT0FBTztJQUMxQyw0QkFBNEIsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUNyQyw0QkFBNEIsR0FBRyxJQUFJLENBQUM7QUFDdEMsQ0FBQyJ9
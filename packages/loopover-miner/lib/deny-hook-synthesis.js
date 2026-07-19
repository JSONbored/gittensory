// Synthesize PreToolUse deny-hook rule proposals from per-repo blocker/path history (#4522). The pure synthesis
// logic moved into `@loopover/engine` (packages/loopover-engine/src/miner/deny-hook-synthesis.ts) by #5667;
// this module is now a thin wrapper that re-exports those pure helpers and keeps the local SQLite store for
// refresh + maintainer review before any synthesized rule takes effect. Approved rules merge with
// {@link DEFAULT_DENY_RULES}; unapproved proposals never block tool calls. No behavior change.
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { aggregateBlockerHistory, canonicalizeChangedPath, changedPathToDenyGlob, DEFAULT_SYNTHESIS_CONFIG, isCoveredByDefaultDenyRules, normalizeBlockerHistory, normalizeBlockerHistoryRecord, normalizeRepoFullName, proposalStatusSet, resolveEffectiveDenyRules, setProposalStatuses, synthesizeDenyRuleProposals as engineSynthesizeDenyRuleProposals, } from "@loopover/engine";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
// Re-export the pure synthesis helpers from the engine so this module's public API is unchanged after #5667
// moved derivation/audit into @loopover/engine. Only the SQLite store below (and its forge/db-path helpers) is
// miner-local, because it depends on node:sqlite/node:fs and this package's forge-config default.
export { aggregateBlockerHistory, canonicalizeChangedPath, changedPathToDenyGlob, DEFAULT_SYNTHESIS_CONFIG, isCoveredByDefaultDenyRules, normalizeBlockerHistory, normalizeBlockerHistoryRecord, resolveEffectiveDenyRules, setProposalStatuses, };
const defaultDbFileName = "deny-hook-synthesis.sqlite3";
/**
 * Derive candidate deny-hook rules from blocker/path history. Miner-facing wrapper over the engine's pure
 * `synthesizeDenyRuleProposals`, defaulting the injected clock to `Date.now()` so this keeps the pre-#5667 2-arg
 * signature (and wall-clock `audit.synthesizedAt`) every existing caller and test relies on. Returns proposal
 * objects only — nothing is active until a maintainer approves them (see resolveEffectiveDenyRules).
 */
export function synthesizeDenyRuleProposals(records, config = {}) {
    return engineSynthesizeDenyRuleProposals(records, config, Date.now());
}
/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
    if (apiBaseUrl === undefined || apiBaseUrl === null)
        return DEFAULT_FORGE_CONFIG.apiBaseUrl;
    if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim())
        throw new Error("invalid_api_base_url");
    return apiBaseUrl.trim();
}
export function resolveDenyHookSynthesisDbPath(env = process.env) {
    const explicitPath = typeof env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB === "string"
        ? env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB.trim()
        : "";
    if (explicitPath)
        return explicitPath;
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
        ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
        : "";
    if (explicitConfigDir)
        return join(explicitConfigDir, defaultDbFileName);
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner", defaultDbFileName);
}
// `dbPath` is always a real string here: this function's only caller (initDenyHookSynthesisStore) already
// defaults its own parameter to resolveDenyHookSynthesisDbPath() before ever reaching this call, so the
// nullish fallback historically here could never actually fire.
function normalizeDbPath(dbPath) {
    const path = dbPath.trim();
    if (!path)
        throw new Error("invalid_deny_hook_synthesis_db_path");
    return path;
}
function rowToProposal(row) {
    return {
        id: row.id,
        status: row.status,
        rule: JSON.parse(row.rule_json),
        audit: JSON.parse(row.audit_json),
    };
}
// Rebuild deny_rule_proposals' (repo_full_name, id) PRIMARY KEY into a (api_base_url, repo_full_name, id)
// composite (#5563) -- two forge hosts serving a same-named owner/repo must not share one proposal row. SQLite
// cannot ALTER a PRIMARY KEY in place, so this rebuilds the table: create the new shape, copy every existing row
// with the pre-#4784 implicit single-forge default backfilled, drop the old table, rename the new one in.
// Guarded by a column-presence check (this module has no schema-version framework of its own, unlike the
// package's other local stores) so this only runs once per file.
function ensureDenyRuleProposalsForgeScope(db) {
    const hasApiBaseUrlColumn = db
        .prepare("PRAGMA table_info(deny_rule_proposals)")
        .all()
        .some((column) => column.name === "api_base_url");
    if (hasApiBaseUrlColumn)
        return;
    db.exec(`
    CREATE TABLE deny_rule_proposals_v2 (
      api_base_url TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
      rule_json TEXT NOT NULL,
      audit_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (api_base_url, repo_full_name, id)
    )
  `);
    // OR IGNORE: a row this store's own read path already treats as unusable garbage (an unrecognized `status`,
    // e.g. from a hand-edited or otherwise corrupted file) would violate the CHECK constraint above and abort the
    // whole migration. Skipping it here is consistent with that same fail-closed posture, rather than turning one
    // bad row into a permanently unmigratable file.
    db.prepare(`INSERT OR IGNORE INTO deny_rule_proposals_v2 (api_base_url, repo_full_name, id, status, rule_json, audit_json, updated_at)
     SELECT ?, repo_full_name, id, status, rule_json, audit_json, updated_at FROM deny_rule_proposals`).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
    db.exec("DROP TABLE deny_rule_proposals");
    db.exec("ALTER TABLE deny_rule_proposals_v2 RENAME TO deny_rule_proposals");
}
/**
 * Local SQLite store for synthesized deny-rule proposals. Refresh re-derives proposals from history while
 * preserving maintainer decisions on ids that still exist.
 */
export function initDenyHookSynthesisStore(dbPath = resolveDenyHookSynthesisDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(resolvedPath);
    chmodSync(resolvedPath, 0o600);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
    CREATE TABLE IF NOT EXISTS deny_rule_proposals (
      repo_full_name TEXT NOT NULL,
      id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
      rule_json TEXT NOT NULL,
      audit_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repo_full_name, id)
    )
  `);
    ensureDenyRuleProposalsForgeScope(db);
    const upsertStatement = db.prepare(`
    INSERT INTO deny_rule_proposals (api_base_url, repo_full_name, id, status, rule_json, audit_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(api_base_url, repo_full_name, id) DO UPDATE SET
      status = excluded.status,
      rule_json = excluded.rule_json,
      audit_json = excluded.audit_json,
      updated_at = excluded.updated_at
  `);
    const getStatusStatement = db.prepare("SELECT status FROM deny_rule_proposals WHERE api_base_url = ? AND repo_full_name = ? AND id = ?");
    const listStatement = db.prepare("SELECT repo_full_name, id, status, rule_json, audit_json, updated_at FROM deny_rule_proposals WHERE api_base_url = ? AND repo_full_name = ? ORDER BY id ASC");
    const setStatusStatement = db.prepare(`
    UPDATE deny_rule_proposals SET status = ?, updated_at = ? WHERE api_base_url = ? AND repo_full_name = ? AND id = ?
  `);
    const store = {
        dbPath: resolvedPath,
        refreshProposals(repoFullName, history, config = {}, apiBaseUrl) {
            const forge = normalizeApiBaseUrl(apiBaseUrl);
            const repo = normalizeRepoFullName(repoFullName);
            const synthesized = synthesizeDenyRuleProposals(history, config);
            const updatedAt = new Date().toISOString();
            db.exec("BEGIN IMMEDIATE");
            try {
                for (const proposal of synthesized) {
                    const existing = getStatusStatement.get(forge, repo, proposal.id);
                    const status = existing?.status && proposalStatusSet.has(existing.status) && existing.status !== "proposed"
                        ? existing.status
                        : "proposed";
                    upsertStatement.run(forge, repo, proposal.id, status, JSON.stringify(proposal.rule), JSON.stringify(proposal.audit), updatedAt);
                }
                db.exec("COMMIT");
            }
            catch (error) {
                // Defensive: a genuine mid-transaction SQLite failure (disk full, corruption) rather than dead code --
                // deliberately not exercised by a contrived unit test, since forcing it would require mocking
                // node:sqlite's DatabaseSync rather than driving this through the real public API.
                db.exec("ROLLBACK");
                throw error;
            }
            return listStatement.all(forge, repo).map(rowToProposal);
        },
        listProposals(repoFullName, apiBaseUrl) {
            const forge = normalizeApiBaseUrl(apiBaseUrl);
            const repo = normalizeRepoFullName(repoFullName);
            return listStatement.all(forge, repo).map(rowToProposal);
        },
        setProposalStatus(repoFullName, proposalId, status, apiBaseUrl) {
            const forge = normalizeApiBaseUrl(apiBaseUrl);
            const repo = normalizeRepoFullName(repoFullName);
            if (typeof proposalId !== "string" || !proposalId.trim())
                throw new Error("invalid_proposal_id");
            if (!proposalStatusSet.has(status))
                throw new Error("invalid_proposal_status");
            setStatusStatement.run(status, new Date().toISOString(), forge, repo, proposalId.trim());
        },
        resolveEffectiveRules(repoFullName, options = {}) {
            const proposals = store.listProposals(repoFullName, options.apiBaseUrl);
            return resolveEffectiveDenyRules({
                includeDefaults: options.includeDefaults,
                approvedProposals: proposals,
            });
        },
        close() {
            db.close();
        },
    };
    return store;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVueS1ob29rLXN5bnRoZXNpcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImRlbnktaG9vay1zeW50aGVzaXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0hBQWdIO0FBQ2hILDRHQUE0RztBQUM1Ryw0R0FBNEc7QUFDNUcsa0dBQWtHO0FBQ2xHLCtGQUErRjtBQUMvRixPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUMvQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQzFDLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDM0MsT0FBTyxFQUNMLHVCQUF1QixFQUN2Qix1QkFBdUIsRUFDdkIscUJBQXFCLEVBQ3JCLHdCQUF3QixFQUN4QiwyQkFBMkIsRUFDM0IsdUJBQXVCLEVBQ3ZCLDZCQUE2QixFQUM3QixxQkFBcUIsRUFDckIsaUJBQWlCLEVBQ2pCLHlCQUF5QixFQUN6QixtQkFBbUIsRUFDbkIsMkJBQTJCLElBQUksaUNBQWlDLEdBQ2pFLE1BQU0sa0JBQWtCLENBQUM7QUFFMUIsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFHekQsNEdBQTRHO0FBQzVHLCtHQUErRztBQUMvRyxrR0FBa0c7QUFDbEcsT0FBTyxFQUNMLHVCQUF1QixFQUN2Qix1QkFBdUIsRUFDdkIscUJBQXFCLEVBQ3JCLHdCQUF3QixFQUN4QiwyQkFBMkIsRUFDM0IsdUJBQXVCLEVBQ3ZCLDZCQUE2QixFQUM3Qix5QkFBeUIsRUFDekIsbUJBQW1CLEdBQ3BCLENBQUM7QUF3QkYsTUFBTSxpQkFBaUIsR0FBRyw2QkFBNkIsQ0FBQztBQUV4RDs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSwyQkFBMkIsQ0FBQyxPQUFnQixFQUFFLFNBQTBCLEVBQUU7SUFDeEYsT0FB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
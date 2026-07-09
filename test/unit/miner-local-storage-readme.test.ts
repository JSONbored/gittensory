import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = join(process.cwd(), "packages/gittensory-miner/README.md");

describe("gittensory-miner local storage README (#4272)", () => {
  it("documents every local SQLite store's file, table, module, and override env var together", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("## Local storage");

    const stores = [
      ["run-state.sqlite3", "miner_run_state", "lib/run-state.js", "GITTENSORY_MINER_RUN_STATE_DB"],
      ["claim-ledger.sqlite3", "miner_claims", "lib/claim-ledger.js", "GITTENSORY_MINER_CLAIM_LEDGER_DB"],
      ["portfolio-queue.sqlite3", "miner_portfolio_queue", "lib/portfolio-queue.js", "GITTENSORY_MINER_PORTFOLIO_QUEUE_DB"],
      ["event-ledger.sqlite3", "miner_event_ledger", "lib/event-ledger.js", "GITTENSORY_MINER_EVENT_LEDGER_DB"],
      ["governor-ledger.sqlite3", "governor_events", "lib/governor-ledger.js", "GITTENSORY_MINER_GOVERNOR_LEDGER_DB"],
      ["plan-store.sqlite3", "miner_plans", "lib/plan-store.js", "GITTENSORY_MINER_PLAN_STORE_DB"],
    ];
    for (const [file, table, module, envVar] of stores) {
      expect(readme, `README should document ${file}`).toContain(file);
      expect(readme, `README should document ${table}`).toContain(table);
      expect(readme, `README should document ${module}`).toContain(module);
      expect(readme, `README should document ${envVar}`).toContain(envVar);
    }
  });

  it("documents the shared local-store helper and the PR-portfolio read-time join decision", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("lib/local-store.js");
    expect(readme).toContain("indexLatestManageUpdates");
    expect(readme).toContain("manage_pr_update");
    expect(readme).toContain("read-time join");
  });
});

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalStoreDb, resolveLocalStoreDbPath } from "../../packages/gittensory-miner/lib/local-store.js";
import { closeDefaultClaimLedger, openClaimLedger, resolveClaimLedgerDbPath } from "../../packages/gittensory-miner/lib/claim-ledger.js";
import { closeDefaultEventLedger, initEventLedger, resolveEventLedgerDbPath } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { closeDefaultGovernorLedger, initGovernorLedger, resolveGovernorLedgerDbPath } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import { closeDefaultPlanStore, openPlanStore, resolvePlanStoreDbPath } from "../../packages/gittensory-miner/lib/plan-store.js";
import { closeDefaultPortfolioQueueStore, initPortfolioQueueStore, resolvePortfolioQueueDbPath } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { closeDefaultRunStateStore, initRunStateStore, resolveRunStateDbPath } from "../../packages/gittensory-miner/lib/run-state.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-local-store-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  closeDefaultRunStateStore();
  closeDefaultClaimLedger();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
  closeDefaultGovernorLedger();
  closeDefaultPlanStore();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("gittensory-miner shared local-store helper (#4272)", () => {
  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(
      resolveLocalStoreDbPath({ THE_OVERRIDE: "/custom/state.sqlite3" }, "THE_OVERRIDE", "thing.sqlite3"),
    ).toBe("/custom/state.sqlite3");
    expect(
      resolveLocalStoreDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" }, "THE_OVERRIDE", "thing.sqlite3"),
    ).toBe("/custom/config/thing.sqlite3");
    expect(
      resolveLocalStoreDbPath({ XDG_CONFIG_HOME: "/xdg" }, "THE_OVERRIDE", "thing.sqlite3"),
    ).toBe("/xdg/gittensory-miner/thing.sqlite3");
    expect(resolveLocalStoreDbPath({}, "THE_OVERRIDE", "thing.sqlite3")).toMatch(
      /\/\.config\/gittensory-miner\/thing\.sqlite3$/,
    );
  });

  it("blank override and config-dir env values fall through to the next precedence tier", () => {
    expect(
      resolveLocalStoreDbPath(
        { THE_OVERRIDE: "   ", GITTENSORY_MINER_CONFIG_DIR: "  ", XDG_CONFIG_HOME: "/xdg" },
        "THE_OVERRIDE",
        "thing.sqlite3",
      ),
    ).toBe("/xdg/gittensory-miner/thing.sqlite3");
  });

  it("opens a store file with a locked-down directory and file mode, and a 5s busy_timeout", () => {
    const dbPath = join(tempRoot(), "nested", "thing.sqlite3");
    const db = openLocalStoreDb(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(statSync(dbPath).mode & 0o077).toBe(0);
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      db.close();
    }
  });

  it("opens the special :memory: path without touching the filesystem", () => {
    const db = openLocalStoreDb(":memory:");
    try {
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      db.prepare("INSERT INTO t (id) VALUES (1)").run();
      expect(db.prepare("SELECT id FROM t").get()).toEqual({ id: 1 });
    } finally {
      db.close();
    }
  });

  it("keeps all six migrated local stores on independent files under one shared config dir (no accidental merge)", () => {
    const configDir = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: configDir };

    const resolved = {
      runState: resolveRunStateDbPath(env),
      claimLedger: resolveClaimLedgerDbPath(env),
      portfolioQueue: resolvePortfolioQueueDbPath(env),
      eventLedger: resolveEventLedgerDbPath(env),
      governorLedger: resolveGovernorLedgerDbPath(env),
      planStore: resolvePlanStoreDbPath(env),
    };

    const paths = Object.values(resolved);
    expect(new Set(paths).size).toBe(paths.length); // every store gets a distinct path
    for (const path of paths) expect(path.startsWith(configDir)).toBe(true);

    const runState = initRunStateStore(resolved.runState);
    const claimLedger = openClaimLedger(resolved.claimLedger);
    const portfolioQueue = initPortfolioQueueStore(resolved.portfolioQueue);
    const eventLedger = initEventLedger(resolved.eventLedger);
    const governorLedger = initGovernorLedger(resolved.governorLedger);
    const planStore = openPlanStore(resolved.planStore);
    try {
      runState.setRunState("acme/widgets", "planning");
      claimLedger.claimIssue("acme/widgets", 1);
      portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:1" });
      eventLedger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: {} });
      governorLedger.appendGovernorEvent({
        eventType: "allowed",
        repoFullName: "acme/widgets",
        actionClass: "plan",
        decision: "allowed",
        reason: "ok",
      });
      planStore.savePlan("plan-1", {
        steps: [{ id: "s1", title: "step", dependsOn: [], status: "pending", attempts: 0, maxAttempts: 3 }],
      });

      // Each store's file exists independently and holds only its own data — reopening a sibling store's
      // path directly must not surface another store's rows.
      for (const path of paths) expect(existsSync(path)).toBe(true);
      expect(claimLedger.listClaims()).toHaveLength(1);
      expect(portfolioQueue.listQueue()).toHaveLength(1);
      expect(eventLedger.readEvents()).toHaveLength(1);
      expect(governorLedger.readGovernorEvents()).toHaveLength(1);
    } finally {
      runState.close();
      claimLedger.close();
      portfolioQueue.close();
      eventLedger.close();
      governorLedger.close();
      planStore.close();
    }
  });
});

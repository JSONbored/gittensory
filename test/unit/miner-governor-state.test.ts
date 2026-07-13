import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultGovernorState,
  loadPauseState,
  openGovernorState,
  savePauseState,
} from "../../packages/gittensory-miner/lib/governor-state.js";

const roots: string[] = [];
const states: Array<{ close(): void }> = [];

function tempState() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-state-"));
  roots.push(root);
  const state = openGovernorState(join(root, "governor-state.sqlite3"));
  states.push(state);
  return state;
}

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  closeDefaultGovernorState();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("governor-state rate-limit state (#5134)", () => {
  it("defaults to empty buckets and backoff when nothing has been saved yet", () => {
    const state = tempState();
    expect(state.loadRateLimitState()).toEqual({ buckets: { global: {}, perRepo: {} }, backoffAttempts: {} });
  });

  it("round-trips saved buckets and backoff attempts", () => {
    const state = tempState();
    state.saveRateLimitState({
      buckets: { global: { open_pr: { count: 3, windowStartMs: 1000 } }, perRepo: {} },
      backoffAttempts: { "open_pr:acme/widgets": 2 },
    });
    expect(state.loadRateLimitState()).toEqual({
      buckets: { global: { open_pr: { count: 3, windowStartMs: 1000 } }, perRepo: {} },
      backoffAttempts: { "open_pr:acme/widgets": 2 },
    });
  });

  it("a second save overwrites the first (current-state semantics, not append)", () => {
    const state = tempState();
    state.saveRateLimitState({ buckets: { global: { open_pr: { count: 1, windowStartMs: 0 } }, perRepo: {} }, backoffAttempts: {} });
    state.saveRateLimitState({ buckets: { global: { open_pr: { count: 2, windowStartMs: 0 } }, perRepo: {} }, backoffAttempts: {} });
    expect(state.loadRateLimitState().buckets.global.open_pr?.count).toBe(2);
  });

  it("saving rate-limit state preserves a previously saved cap usage in the same scalar row", () => {
    const state = tempState();
    state.saveCapUsage({ budgetSpent: 42, turnsTaken: 3, elapsedMs: 5000 });
    state.saveRateLimitState({ buckets: { global: {}, perRepo: {} }, backoffAttempts: {} });
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 42, turnsTaken: 3, elapsedMs: 5000 });
  });
});

describe("governor-state cap usage (#5134)", () => {
  it("defaults to zeroed usage when nothing has been saved yet", () => {
    const state = tempState();
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 });
  });

  it("round-trips saved cap usage and preserves a previously saved rate-limit state", () => {
    const state = tempState();
    state.saveRateLimitState({ buckets: { global: { open_pr: { count: 1, windowStartMs: 0 } }, perRepo: {} }, backoffAttempts: {} });
    state.saveCapUsage({ budgetSpent: 10, turnsTaken: 1, elapsedMs: 100 });
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 10, turnsTaken: 1, elapsedMs: 100 });
    expect(state.loadRateLimitState().buckets.global.open_pr?.count).toBe(1);
  });
});

describe("governor-state pause/resume control surface (#4851)", () => {
  it("defaults to not-paused when nothing has been saved yet", () => {
    const state = tempState();
    expect(state.loadPauseState()).toEqual({ paused: false, reason: null, pausedAt: null });
  });

  it("pausing stamps pausedAt and stores a trimmed reason", () => {
    const state = tempState();
    const before = Date.now();
    const written = state.savePauseState({ paused: true, reason: "  operator requested  " });
    expect(written.paused).toBe(true);
    expect(written.reason).toBe("operator requested");
    expect(Date.parse(written.pausedAt ?? "")).toBeGreaterThanOrEqual(before);
    expect(state.loadPauseState()).toEqual(written);
  });

  it("pausing with no reason stores a null reason", () => {
    const state = tempState();
    const written = state.savePauseState({ paused: true });
    expect(written.reason).toBeNull();
  });

  it("pausing with a blank reason stores a null reason", () => {
    const state = tempState();
    const written = state.savePauseState({ paused: true, reason: "   " });
    expect(written.reason).toBeNull();
  });

  it("resuming clears paused, reason, and pausedAt", () => {
    const state = tempState();
    state.savePauseState({ paused: true, reason: "investigating a bad PR" });
    const resumed = state.savePauseState({ paused: false });
    expect(resumed).toEqual({ paused: false, reason: null, pausedAt: null });
    expect(state.loadPauseState()).toEqual({ paused: false, reason: null, pausedAt: null });
  });

  it("pausing preserves a previously saved cap usage and rate-limit state in the same scalar row", () => {
    const state = tempState();
    state.saveCapUsage({ budgetSpent: 7, turnsTaken: 1, elapsedMs: 500 });
    state.saveRateLimitState({ buckets: { global: { open_pr: { count: 1, windowStartMs: 0 } }, perRepo: {} }, backoffAttempts: {} });
    state.savePauseState({ paused: true, reason: "halting for review" });
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 7, turnsTaken: 1, elapsedMs: 500 });
    expect(state.loadRateLimitState().buckets.global.open_pr?.count).toBe(1);
  });

  it("saving cap usage or rate-limit state preserves a previously saved pause", () => {
    const state = tempState();
    state.savePauseState({ paused: true, reason: "halting for review" });
    state.saveCapUsage({ budgetSpent: 1, turnsTaken: 1, elapsedMs: 1 });
    state.saveRateLimitState({ buckets: { global: {}, perRepo: {} }, backoffAttempts: {} });
    expect(state.loadPauseState()).toMatchObject({ paused: true, reason: "halting for review" });
  });

  it("migrates an on-disk file created before the pause columns existed", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-state-premigration-"));
    roots.push(root);
    const dbPath = join(root, "governor-state.sqlite3");

    // Hand-build the OLD schema (no paused/pause_reason/paused_at columns), with a pre-existing scalar row, to
    // simulate a real file written before #4851.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE governor_scalar_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        rate_limit_buckets_json TEXT NOT NULL,
        rate_limit_backoff_json TEXT NOT NULL,
        cap_usage_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    raw.prepare(
      "INSERT INTO governor_scalar_state (id, rate_limit_buckets_json, rate_limit_backoff_json, cap_usage_json, updated_at) VALUES (1, ?, ?, ?, ?)",
    ).run("{}", "{}", JSON.stringify({ budgetSpent: 9, turnsTaken: 2, elapsedMs: 200 }), "2026-07-01T00:00:00Z");
    raw.close();

    const state = openGovernorState(dbPath);
    states.push(state);
    expect(state.loadPauseState()).toEqual({ paused: false, reason: null, pausedAt: null });
    // The pre-existing row's other columns survived the ALTER TABLE.
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 9, turnsTaken: 2, elapsedMs: 200 });

    state.savePauseState({ paused: true, reason: "post-migration pause" });
    expect(state.loadPauseState()).toMatchObject({ paused: true, reason: "post-migration pause" });
  });

  it("reopening an already-migrated file is a safe no-op (column-presence guard)", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-state-remigrate-"));
    roots.push(root);
    const dbPath = join(root, "governor-state.sqlite3");
    const first = openGovernorState(dbPath);
    first.savePauseState({ paused: true, reason: "first open" });
    first.close();

    const second = openGovernorState(dbPath);
    states.push(second);
    expect(() => second.loadPauseState()).not.toThrow();
    expect(second.loadPauseState()).toMatchObject({ paused: true, reason: "first open" });
  });

  it("REGRESSION: adds each missing pause column independently, not just when `paused` alone is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-state-partial-migration-"));
    roots.push(root);
    const dbPath = join(root, "governor-state.sqlite3");

    // Hand-build a file that already has `paused` but is missing `pause_reason`/`paused_at` -- a state a
    // single "does `paused` exist?" guard would (incorrectly) treat as fully migrated and skip entirely,
    // leaving upsertScalarStatement referencing columns that don't exist.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE governor_scalar_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        rate_limit_buckets_json TEXT NOT NULL,
        rate_limit_backoff_json TEXT NOT NULL,
        cap_usage_json TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
    raw.prepare(
      "INSERT INTO governor_scalar_state (id, rate_limit_buckets_json, rate_limit_backoff_json, cap_usage_json, paused, updated_at) VALUES (1, ?, ?, ?, 0, ?)",
    ).run("{}", "{}", JSON.stringify({ budgetSpent: 3, turnsTaken: 1, elapsedMs: 50 }), "2026-07-01T00:00:00Z");
    raw.close();

    const state = openGovernorState(dbPath);
    states.push(state);
    expect(() => state.loadPauseState()).not.toThrow();
    expect(state.loadPauseState()).toEqual({ paused: false, reason: null, pausedAt: null });
    expect(state.loadCapUsage()).toEqual({ budgetSpent: 3, turnsTaken: 1, elapsedMs: 50 });

    expect(() => state.savePauseState({ paused: true, reason: "partial-migration pause" })).not.toThrow();
    expect(state.loadPauseState()).toMatchObject({ paused: true, reason: "partial-migration pause" });
  });
});

describe("governor-state reputation history (#5134)", () => {
  it("defaults to zero decided/unfavorable for a repo with no history", () => {
    const state = tempState();
    expect(state.loadReputationHistory("acme/widgets")).toEqual({ decided: 0, unfavorable: 0 });
  });

  it("round-trips per-repo history independently", () => {
    const state = tempState();
    state.saveReputationHistory("acme/widgets", { decided: 10, unfavorable: 4 });
    state.saveReputationHistory("acme/gadgets", { decided: 2, unfavorable: 2 });
    expect(state.loadReputationHistory("acme/widgets")).toEqual({ decided: 10, unfavorable: 4 });
    expect(state.loadReputationHistory("acme/gadgets")).toEqual({ decided: 2, unfavorable: 2 });
  });

  it("a second save overwrites (not accumulates) the prior row for the same repo", () => {
    const state = tempState();
    state.saveReputationHistory("acme/widgets", { decided: 1, unfavorable: 1 });
    state.saveReputationHistory("acme/widgets", { decided: 5, unfavorable: 1 });
    expect(state.loadReputationHistory("acme/widgets")).toEqual({ decided: 5, unfavorable: 1 });
  });

  it("rejects a malformed repoFullName", () => {
    const state = tempState();
    expect(() => state.loadReputationHistory("not-a-repo")).toThrow(/invalid_repo_full_name/);
    expect(() => state.saveReputationHistory("not-a-repo", { decided: 1, unfavorable: 0 })).toThrow(/invalid_repo_full_name/);
  });
});

describe("governor-state own-submission history (#5134)", () => {
  it("records and lists submissions newest-first", () => {
    const state = tempState();
    state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fix auth bug", submittedAt: "2026-07-10T12:00:00Z", pullRequestNumber: 41 });
    state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fix login flow", submittedAt: "2026-07-11T12:00:00Z", pullRequestNumber: 42 });

    const all = state.listRecentOwnSubmissions();
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual({ repoFullName: "acme/widgets", fingerprint: "fix login flow", submittedAt: "2026-07-11T12:00:00Z", pullRequestNumber: 42, issueNumber: null });
    expect(all[1]?.fingerprint).toBe("fix auth bug");
  });

  it("filters by repoFullName", () => {
    const state = tempState();
    state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "a" });
    state.recordOwnSubmission({ repoFullName: "acme/gadgets", fingerprint: "b" });
    expect(state.listRecentOwnSubmissions({ repoFullName: "acme/gadgets" })).toHaveLength(1);
    expect(state.listRecentOwnSubmissions({ repoFullName: "acme/widgets" })[0]?.fingerprint).toBe("a");
  });

  it("respects a caller-supplied limit and defaults to 200", () => {
    const state = tempState();
    for (let i = 0; i < 5; i += 1) state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: `fp-${i}` });
    expect(state.listRecentOwnSubmissions({ limit: 2 })).toHaveLength(2);
    expect(state.listRecentOwnSubmissions()).toHaveLength(5);
  });

  it("defaults submittedAt to now and optional numbers to null when omitted", () => {
    const state = tempState();
    const before = Date.now();
    const recorded = state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "fp" });
    expect(recorded.pullRequestNumber).toBeNull();
    expect(recorded.issueNumber).toBeNull();
    expect(Date.parse(recorded.submittedAt ?? "")).toBeGreaterThanOrEqual(before);
  });

  it("rejects a missing or blank fingerprint", () => {
    const state = tempState();
    expect(() => state.recordOwnSubmission({ repoFullName: "acme/widgets", fingerprint: "" })).toThrow(/invalid_fingerprint/);
    expect(() => state.recordOwnSubmission({ repoFullName: "acme/widgets" } as never)).toThrow(/invalid_fingerprint/);
  });
});

describe("governor-state module-level default singleton (#5134)", () => {
  it("closeDefaultGovernorState is a safe no-op when nothing was ever opened", () => {
    expect(() => closeDefaultGovernorState()).not.toThrow();
  });

  it("loadPauseState/savePauseState module-level wrappers round-trip through the default singleton (#4851)", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-state-singleton-"));
    roots.push(root);
    vi.stubEnv("GITTENSORY_MINER_GOVERNOR_STATE_DB", join(root, "governor-state.sqlite3"));
    expect(loadPauseState()).toEqual({ paused: false, reason: null, pausedAt: null });
    const written = savePauseState({ paused: true, reason: "singleton pause" });
    expect(written).toMatchObject({ paused: true, reason: "singleton pause" });
    expect(loadPauseState()).toEqual(written);
  });
});

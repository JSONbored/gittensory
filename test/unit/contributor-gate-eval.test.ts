import { describe, expect, it } from "vitest";
import {
  computeContributorGateEval,
  type ContributorGateEvalRow,
  contributorFairnessFlags,
} from "../../src/review/contributor-gate-eval";
import { REVERSAL_DISCOUNT_WEIGHT } from "../../src/review/parity";
import { upsertRepositorySettings } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-07-20T00:00:00Z");

// Stub D1 returning a fixed cell result set -- mirrors parity.test.ts's own computeGateEval fixture style
// exactly, since this module's fold logic is a direct per-login port of that one.
function cellEnv(cells: Array<{ login: string; project: string; pred: string; truth: string; reversed?: number; n: number }>): Env {
  return { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: cells }) }) }) } } as unknown as Env;
}

describe("computeContributorGateEval — per-(login, project) gate accuracy (#fairness-analytics)", () => {
  it("folds a mixed cell set into per-login-per-project confusion-matrix precision", async () => {
    const out = await computeContributorGateEval(
      cellEnv([
        { login: "octocat", project: "p", pred: "merge", truth: "merged", n: 8 },
        { login: "octocat", project: "p", pred: "merge", truth: "closed", n: 2 },
        { login: "octocat", project: "p", pred: "close", truth: "closed", n: 5 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.login).toBe("octocat");
    expect(r.project).toBe("p");
    expect(r.wouldMerge).toBe(10);
    expect(r.mergeConfirmed).toBe(8);
    expect(r.mergePrecision).toBeCloseTo(0.8);
    expect(r.wouldClose).toBe(5);
    expect(r.closeConfirmed).toBe(5);
    expect(r.closePrecision).toBe(1);
    expect(r.decided).toBe(15);
    // weightedAccuracy = (weightedMergeConfirmed + weightedCloseConfirmed) / decided = (8 + 5) / 15
    expect(r.weightedAccuracy).toBeCloseTo(13 / 15);
    expect(out.hasSignal).toBe(true); // decided(15) >= 10
  });

  it("keeps two logins on the SAME project as separate rows", async () => {
    const out = await computeContributorGateEval(
      cellEnv([
        { login: "octocat", project: "p", pred: "merge", truth: "merged", n: 3 },
        { login: "hubot", project: "p", pred: "close", truth: "closed", n: 2 },
      ]),
      { days: 90, nowMs: NOW },
    );
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.login)).toEqual(["hubot", "octocat"]); // sorted login asc
  });

  it("sorts by login then project when the SAME login appears in multiple projects", async () => {
    const out = await computeContributorGateEval(
      cellEnv([
        { login: "octocat", project: "zeta", pred: "merge", truth: "merged", n: 1 },
        { login: "octocat", project: "alpha", pred: "merge", truth: "merged", n: 1 },
      ]),
      { days: 90, nowMs: NOW },
    );
    expect(out.rows.map((r) => r.project)).toEqual(["alpha", "zeta"]);
  });

  it("#2348-equivalent: discounts a reverted merge's credit to weightedMergeConfirmed, but not the raw mergeConfirmed", async () => {
    const out = await computeContributorGateEval(
      cellEnv([
        { login: "octocat", project: "p", pred: "merge", truth: "merged", reversed: 0, n: 6 },
        { login: "octocat", project: "p", pred: "merge", truth: "merged", reversed: 1, n: 4 }, // later reverted
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0]!;
    expect(r.mergeConfirmed).toBe(10); // raw: unaffected by reversal
    expect(r.mergePrecision).toBe(1);
    // REVERSAL_DISCOUNT_WEIGHT is 0 -- the reverted 4 earn zero weighted credit.
    expect(r.weightedMergeConfirmed).toBe(6 + 4 * REVERSAL_DISCOUNT_WEIGHT);
    expect(r.weightedMergePrecision).toBeCloseTo((6 + 4 * REVERSAL_DISCOUNT_WEIGHT) / 10);
    expect(r.weightedAccuracy).toBeCloseTo((6 + 4 * REVERSAL_DISCOUNT_WEIGHT) / 10);
  });

  it("leaves precisions and weightedAccuracy null when nothing decided for that (login, project)", async () => {
    const out = await computeContributorGateEval(cellEnv([{ login: "octocat", project: "p", pred: "hold", truth: "merged", n: 4 }]), { days: 90, nowMs: NOW });
    const r = out.rows[0]!;
    expect(r.mergePrecision).toBeNull();
    expect(r.closePrecision).toBeNull();
    expect(r.decided).toBe(4);
    // pred="hold" falls through both branches: decided still increments, weightedAccuracy stays null (0 decided
    // toward either confusion bucket, but the decided count itself is non-zero) -- matches computeGateEval's own
    // "counts decided but no confusion bucket" behavior for an unrecognized prediction.
    expect(r.weightedAccuracy).toBe(0); // (0 + 0) / 4
    expect(out.hasSignal).toBe(false); // 4 < MIN_DECIDED_FOR_SIGNAL(10)
  });

  it("counts a false-close (would-close, human merged) and ignores a decided-but-inconclusive outcome", async () => {
    const out = await computeContributorGateEval(
      cellEnv([
        { login: "octocat", project: "p", pred: "close", truth: "merged", n: 1 }, // false-close: the dangerous error
        { login: "octocat", project: "p", pred: "merge", truth: "expired", n: 4 }, // neither merged nor closed
        { login: "octocat", project: "p", pred: "close", truth: "expired", n: 3 }, // neither merged nor closed
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0]!;
    expect(r.wouldClose).toBe(4); // 1 false-close + 3 expired
    expect(r.closeConfirmed).toBe(0);
    expect(r.closeFalse).toBe(1);
    expect(r.closePrecision).toBe(0);
    expect(r.wouldMerge).toBe(4);
    expect(r.mergeConfirmed).toBe(0);
    expect(r.mergeFalse).toBe(0); // expired is neither confirmed nor false
    expect(r.mergePrecision).toBe(0);
  });

  it("leaves weightedAccuracy null for a (login, project) key with zero decided", async () => {
    // A cell with n=0 can't come from a real GROUP BY COUNT(*) query, but exercises the decided<=0 branch
    // directly rather than asserting it's unreachable.
    const out = await computeContributorGateEval(cellEnv([{ login: "octocat", project: "p", pred: "merge", truth: "merged", n: 0 }]), { days: 90, nowMs: NOW });
    expect(out.rows[0]!.decided).toBe(0);
    expect(out.rows[0]!.weightedAccuracy).toBeNull();
  });

  it("binds the login filter when opts.login is set, and omits it (single bind) when not", async () => {
    const capture: { sql?: string; binds?: unknown[] } = {};
    const cap = (): Env =>
      ({
        DB: {
          prepare: (sql: string) => {
            capture.sql = sql;
            return { bind: (...a: unknown[]) => { capture.binds = a; return { all: async () => ({ results: [] }) }; } };
          },
        },
      }) as unknown as Env;

    await computeContributorGateEval(cap(), { days: 90, nowMs: NOW, login: "octocat" });
    expect(capture.sql).toContain("AND login = ?");
    expect(capture.binds).toHaveLength(2);
    expect(capture.binds?.[1]).toBe("octocat");

    await computeContributorGateEval(cap(), { days: 90, nowMs: NOW });
    expect(capture.sql).not.toContain("AND login = ?");
    expect(capture.binds).toHaveLength(1);
  });

  it("REGRESSION (#fairness-analytics): excludes a project whose OWN .loopover.yml sets fairnessAnalyticsMode: off", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/opted-out" });
    await upsertRepoFocusManifest(env, "owner/opted-out", { settings: { fairnessAnalyticsMode: "off" } });

    const insert = async (project: string, pr: number): Promise<void> => {
      const targetId = `${project}#${pr}`;
      await env.DB.prepare(`INSERT INTO contributor_gate_history (id, login, source, project, target_id, decision, created_at) VALUES (?, 'octocat', 'gittensory-native', ?, ?, 'merge', ?)`)
        .bind(`cgh-${targetId}`, project, targetId, new Date().toISOString())
        .run();
      await env.DB.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES (?, ?, ?, 'pr_outcome', 'merged', 'github', ?)`)
        .bind(`po-${targetId}`, project, targetId, new Date().toISOString())
        .run();
    };
    await insert("owner/opted-out", 1);
    await insert("owner/opted-in", 2);

    const out = await computeContributorGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows.map((r) => r.project)).toEqual(["owner/opted-in"]);
  });

  it("REGRESSION (#fairness-analytics): a settings-resolution error degrades to eligible (fail-open), not a dropped project", async () => {
    const env = createTestEnv();
    await env.DB.prepare(`INSERT INTO contributor_gate_history (id, login, source, project, target_id, decision, created_at) VALUES ('cgh-1', 'octocat', 'gittensory-native', 'owner/repo', 'owner/repo#1', 'merge', ?)`)
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES ('po-1', 'owner/repo', 'owner/repo#1', 'pr_outcome', 'merged', 'github', ?)`)
      .bind(new Date().toISOString())
      .run();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/repository_settings/i.test(sql)) throw new Error("poisoned settings read");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    const out = await computeContributorGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows.map((r) => r.project)).toEqual(["owner/repo"]);
  });

  it("is fail-safe: a throwing D1 read degrades to an empty report, not an error", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("d1 down"); } }) }) } } as unknown as Env;
    const out = await computeContributorGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
    expect(out.hasSignal).toBe(false);
  });

  it("defaults to [] when the driver returns no `results` field (nullish fallback)", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({}) }) }) } } as unknown as Env;
    const out = await computeContributorGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
  });

  it("clamps an over-long days window to 730 and defaults a non-positive/non-finite days to 90", async () => {
    const cap = (capture: { binds?: unknown[] }): Env =>
      ({ DB: { prepare: () => ({ bind: (...a: unknown[]) => { capture.binds = a; return { all: async () => ({ results: [] }) }; } }) } }) as unknown as Env;

    const big: { binds?: unknown[] } = {};
    await computeContributorGateEval(cap(big), { days: 9999, nowMs: NOW });
    expect(big.binds?.[0]).toBe(new Date(NOW - 730 * 86_400_000).toISOString().slice(0, 10));

    const zero: { binds?: unknown[] } = {};
    await computeContributorGateEval(cap(zero), { days: -5, nowMs: NOW });
    expect(zero.binds?.[0]).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));

    const nan: { binds?: unknown[] } = {};
    await computeContributorGateEval(cap(nan), { days: Number.NaN, nowMs: NOW });
    expect(nan.binds?.[0]).toBe(new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10));
  });
});

describe("contributorFairnessFlags — per-login deviation from the project median (#fairness-analytics)", () => {
  const row = (over: Partial<ContributorGateEvalRow>): ContributorGateEvalRow => ({
    login: "octocat", project: "p", wouldMerge: 0, mergeConfirmed: 0, mergeFalse: 0, wouldClose: 0, closeConfirmed: 0, closeFalse: 0, decided: 10,
    mergePrecision: null, closePrecision: null, weightedMergeConfirmed: 0, weightedCloseConfirmed: 0, weightedMergePrecision: null, weightedClosePrecision: null, weightedAccuracy: 0.9,
    ...over,
  });

  it("does not flag a contributor within the outlier band of their project's median", () => {
    const flags = contributorFairnessFlags([
      row({ login: "a", weightedAccuracy: 0.9 }),
      row({ login: "b", weightedAccuracy: 0.85 }), // within 0.25 of the median
    ]);
    expect(flags).toEqual([]);
  });

  it("flags a contributor whose accuracy is UNUSUALLY UNFAVORABLE vs the project median", () => {
    const flags = contributorFairnessFlags([
      row({ login: "a", weightedAccuracy: 0.9 }),
      row({ login: "b", weightedAccuracy: 0.9 }),
      row({ login: "c", weightedAccuracy: 0.5 }), // 0.4 below the median
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ login: "c", project: "p" });
    expect(flags[0]!.deviation).toBeCloseTo(-0.4);
  });

  it("flags a contributor whose accuracy is UNUSUALLY FAVORABLE vs the project median -- neither direction is asserted as fault", () => {
    const flags = contributorFairnessFlags([
      row({ login: "a", weightedAccuracy: 0.5 }),
      row({ login: "b", weightedAccuracy: 0.5 }),
      row({ login: "c", weightedAccuracy: 1.0 }), // 0.5 above the median
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.login).toBe("c");
    expect(flags[0]!.deviation).toBeCloseTo(0.5);
  });

  it("never flags a contributor below the minimum sample size, even with an extreme deviation", () => {
    const flags = contributorFairnessFlags([
      row({ login: "a", weightedAccuracy: 0.9 }),
      row({ login: "b", weightedAccuracy: 0.9 }),
      row({ login: "c", weightedAccuracy: 0, decided: 4 }), // decided < CONTRIBUTOR_MIN_SAMPLE(5)
    ]);
    expect(flags).toEqual([]);
  });

  it("never flags when a project has fewer than 2 eligible contributors (no peer group to compare against)", () => {
    const flags = contributorFairnessFlags([row({ login: "a", weightedAccuracy: 0.1 })]);
    expect(flags).toEqual([]);
  });

  it("skips a row with a null weightedAccuracy (nothing decided) without throwing", () => {
    const flags = contributorFairnessFlags([
      row({ login: "a", weightedAccuracy: 0.9 }),
      row({ login: "b", weightedAccuracy: null }),
    ]);
    expect(flags).toEqual([]);
  });

  it("scopes the median per PROJECT -- an outlier on one project never flags against another project's baseline", () => {
    const flags = contributorFairnessFlags([
      row({ login: "a", project: "p1", weightedAccuracy: 0.9 }),
      row({ login: "b", project: "p1", weightedAccuracy: 0.9 }),
      row({ login: "c", project: "p2", weightedAccuracy: 0.1 }),
      row({ login: "d", project: "p2", weightedAccuracy: 0.1 }),
    ]);
    expect(flags).toEqual([]); // each project's pair matches its OWN median exactly
  });

  it("returns [] for an empty input", () => {
    expect(contributorFairnessFlags([])).toEqual([]);
  });

  it("breaks ties on project when the SAME login is flagged on multiple projects", () => {
    const flags = contributorFairnessFlags([
      row({ login: "octocat", project: "zeta", weightedAccuracy: 0.1 }),
      row({ login: "peer", project: "zeta", weightedAccuracy: 0.9 }),
      row({ login: "octocat", project: "alpha", weightedAccuracy: 0.1 }),
      row({ login: "peer", project: "alpha", weightedAccuracy: 0.9 }),
    ]);
    expect(flags.map((f) => `${f.login}:${f.project}`)).toEqual(["octocat:alpha", "octocat:zeta", "peer:alpha", "peer:zeta"]);
  });

  it("sorts flags by login then project", () => {
    const flags = contributorFairnessFlags([
      row({ login: "zeta", project: "p", weightedAccuracy: 0.9 }),
      row({ login: "mid", project: "p", weightedAccuracy: 0.5 }), // median: (0.9+0.5)/2=0.7, neither flags alone...
      row({ login: "alpha", project: "p", weightedAccuracy: 0.1 }), // ...but this pulls the median down
    ]);
    expect(flags.map((f) => f.login)).toEqual(["alpha", "zeta"]);
  });
});

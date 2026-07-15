import { describe, expect, it } from "vitest";

import { buildCustomerLoopView, type CustomerLoopViewInput } from "../../packages/loopover-engine/src/customer-loop-view";
import type { LoopConsumptionEntry } from "../../packages/loopover-engine/src/loop-consumption";
import type { ProgressSnapshot } from "../../packages/loopover-engine/src/loop-progress";
import type { ResultsPayload } from "../../packages/loopover-engine/src/results-payload";

const progress = (over: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
  phase: "coding",
  status: "running",
  iteration: 2,
  maxIterations: 5,
  percentComplete: 40,
  recentActivity: [{ step: "ran tests" }],
  done: false,
  ...over,
});

const entry = (over: Partial<LoopConsumptionEntry> = {}): LoopConsumptionEntry => ({
  tenantId: "acme",
  loopId: "loop-1",
  outcome: "completed",
  wallClockMs: 30_000,
  computeUnits: 40,
  complete: true,
  ...over,
});

const results = (): ResultsPayload => ({
  prLink: "https://github.com/acme/widgets/pull/7",
  summary: "Opened a PR fixing the reported crash.",
  diffPreview: [{ path: "src/app.ts", additions: 3, deletions: 1 }],
  totals: { files: 1, additions: 3, deletions: 1 },
});

const input = (over: Partial<CustomerLoopViewInput> = {}): CustomerLoopViewInput => ({
  tenantId: "acme",
  loopId: "loop-1",
  progress: progress(),
  ...over,
});

const QUOTA = { computeUnits: 100, wallClockMs: 60_000, maxConcurrentLoops: 2 };

describe("buildCustomerLoopView (#4807)", () => {
  it("surfaces the loop's own progress snapshot untouched — the customer sees exactly the #4800 stream", () => {
    const snapshot = progress();
    const view = buildCustomerLoopView(input({ progress: snapshot }));
    expect(view.loopId).toBe("loop-1");
    expect(view.progress).toEqual(snapshot);
  });

  it("reports spend from the customer's own consumption entries (#4792)", () => {
    const view = buildCustomerLoopView(input({ consumption: [entry(), entry({ loopId: "loop-2", computeUnits: 10, wallClockMs: 5_000 })] }));
    expect(view.spend.computeUnitsUsed).toBe(50);
    expect(view.spend.wallClockMsUsed).toBe(35_000);
  });

  it("a loop with no consumption yet reports zero spend, not undefined", () => {
    expect(buildCustomerLoopView(input()).spend).toMatchObject({ computeUnitsUsed: 0, wallClockMsUsed: 0 });
    expect(buildCustomerLoopView(input({ consumption: [] })).spend).toMatchObject({ computeUnitsUsed: 0, wallClockMsUsed: 0 });
  });

  // The reason #4807 is "distinct from any internal operations view": a customer sees THEIR loop, nothing else.
  it("INVARIANT: another tenant's entries can never reach this customer's dashboard", () => {
    const view = buildCustomerLoopView(
      input({
        consumption: [entry(), entry({ tenantId: "globex", loopId: "secret", computeUnits: 999, wallClockMs: 999_000 })],
      }),
    );
    expect(view.spend.computeUnitsUsed).toBe(40);
    expect(view.spend.wallClockMsUsed).toBe(30_000);
    expect(JSON.stringify(view)).not.toContain("globex");
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  describe("quota headroom", () => {
    it("reports remaining allocation and within-quota when a quota is configured", () => {
      const view = buildCustomerLoopView(input({ consumption: [entry()], quota: QUOTA }));
      expect(view.spend.remaining).toEqual({ computeUnits: 60, wallClockMs: 30_000 });
      expect(view.spend.withinQuota).toBe(true);
    });

    it("flags a customer who has spent their whole allocation", () => {
      const view = buildCustomerLoopView(input({ consumption: [entry({ computeUnits: 100 })], quota: QUOTA }));
      expect(view.spend.remaining).toEqual({ computeUnits: 0, wallClockMs: 30_000 });
      expect(view.spend.withinQuota).toBe(false);
    });

    it("flags a customer who has burned their whole time allocation", () => {
      const view = buildCustomerLoopView(input({ consumption: [entry({ wallClockMs: 60_000 })], quota: QUOTA }));
      expect(view.spend.withinQuota).toBe(false);
    });

    it("INVARIANT: no quota configured reports null, never a fabricated ceiling", () => {
      for (const q of [undefined, null]) {
        const view = buildCustomerLoopView(input({ consumption: [entry()], quota: q }));
        expect(view.spend.remaining).toBeNull();
        expect(view.spend.withinQuota).toBeNull();
        expect(view.spend.computeUnitsUsed).toBe(40); // spend itself is still real
      }
    });

    // A spend view has no honest activeLoops reading, so it must not answer a concurrency question.
    it("INVARIANT: a concurrency-only limit never makes a within-allocation customer read as over spend", () => {
      const view = buildCustomerLoopView(input({ consumption: [entry()], quota: { ...QUOTA, maxConcurrentLoops: 0 } }));
      expect(view.spend.withinQuota).toBe(true);
      expect(view.spend.remaining).toEqual({ computeUnits: 60, wallClockMs: 30_000 });
    });
  });

  describe("results", () => {
    it("is null while the loop is still running, and not ready", () => {
      const view = buildCustomerLoopView(input());
      expect(view.results).toBeNull();
      expect(view.resultsReady).toBe(false);
    });

    it("INVARIANT: never invites the customer to see results that do not exist yet", () => {
      // done, but nothing produced a payload
      expect(buildCustomerLoopView(input({ progress: progress({ done: true, status: "converged" }) })).resultsReady).toBe(false);
      // a payload exists, but the loop is not done
      expect(buildCustomerLoopView(input({ results: results() })).resultsReady).toBe(false);
    });

    it("is ready once the loop is done and a payload exists", () => {
      const payload = results();
      const view = buildCustomerLoopView(input({ progress: progress({ done: true, status: "converged" }), results: payload }));
      expect(view.results).toEqual(payload);
      expect(view.resultsReady).toBe(true);
    });

    it("an explicit null payload is treated the same as an absent one", () => {
      const view = buildCustomerLoopView(input({ progress: progress({ done: true }), results: null }));
      expect(view.results).toBeNull();
      expect(view.resultsReady).toBe(false);
    });
  });
});

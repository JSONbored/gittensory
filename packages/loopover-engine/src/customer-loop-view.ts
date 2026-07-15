// Customer-facing loop dashboard view model (pure) — #4807, part of the Rent-a-Loop path #4778.
//
// Deterministic and side-effect-free: given ONE customer's own loop, it assembles what their dashboard shows —
// where the loop is (submit → watch progress), what it has cost them (spend), and what came out of it (results).
// That is #4807's "submit → watch progress → see spend and results" as a decision core: the data the surface
// renders, computed once, so the eventual UI only lays it out.
//
// It composes the already-merged halves the issue names rather than restating them: #4800's ProgressSnapshot is
// passed through untouched, and spend comes from #4792's own totalConsumptionForTenant — which is also where
// this view's central guarantee comes from. #4807 exists because a customer's view is "distinct from any
// internal operations view" (#4808's fleet summary): a customer sees THEIR loop and nothing else. So the
// tenant filter is applied here, by that same audited primitive, rather than trusting a caller to have handed
// in a pre-filtered list — a dashboard that renders one customer another's spend is the worst bug this surface
// could have, and "the caller filtered it" is not a defense.
//
// It assembles a view only: no fetching, no rendering, no clock read. Building the surface itself is the
// separate UI work, which the issue additionally gates on the shared design system (#4966/#4967) — so this core
// carries no styling or framework opinion and stays correct whatever renders it.

import { totalConsumptionForTenant, type LoopConsumptionEntry } from "./loop-consumption.js";
import type { ProgressSnapshot } from "./loop-progress.js";
import type { ResultsPayload } from "./results-payload.js";
import { evaluateTenantQuota, type TenantQuota } from "./tenant-quota.js";

export type CustomerLoopViewInput = {
  /** The customer this view belongs to. Every figure below is scoped to them. */
  tenantId: string;
  loopId: string;
  /** #4800's snapshot, passed through as-is — the customer already sees exactly this in the progress stream. */
  progress: ProgressSnapshot;
  /**
   * Consumption entries for the period. MAY contain other tenants' rows — they are filtered out here rather
   * than trusted to have been filtered by the caller.
   */
  consumption?: readonly LoopConsumptionEntry[] | undefined;
  /** #4801's payload once the loop has produced one; absent/null until then — never a placeholder. */
  results?: ResultsPayload | null | undefined;
  /** The customer's allocation, when they have one. Absent means "no quota configured", not "unlimited". */
  quota?: TenantQuota | null | undefined;
};

export type CustomerLoopSpend = {
  computeUnitsUsed: number;
  wallClockMsUsed: number;
  /** Headroom against their allocation, or null when no quota is configured — never guessed. */
  remaining: { computeUnits: number; wallClockMs: number } | null;
  /** Whether they are still within allocation, or null when no quota is configured. */
  withinQuota: boolean | null;
};

export type CustomerLoopView = {
  loopId: string;
  progress: ProgressSnapshot;
  spend: CustomerLoopSpend;
  results: ResultsPayload | null;
  /** True only once the loop is done AND a payload exists — what "see results" waits on. */
  resultsReady: boolean;
};

/**
 * Assemble one customer's loop dashboard view (#4807). Pure: reads only what it is handed and returns a view
 * without fetching, rendering, or mutating anything.
 *
 * Spend is computed by #4792's `totalConsumptionForTenant` against `input.tenantId`, so a row belonging to any
 * other tenant cannot reach this customer's dashboard even if the caller passes the whole period's entries.
 * Quota headroom is only reported when a quota is configured: with none, `remaining`/`withinQuota` are `null`
 * rather than a fabricated ceiling — a customer must be able to tell "no limit is set" from "you have room".
 *
 * Only #4796's SPEND dimensions are read from the quota decision. Its third dimension, concurrency, is not
 * reported here: a spend view has no honest `activeLoops` reading to give it, and inventing one would make the
 * customer's "within allocation" answer depend on a number nobody measured — the same rule #4792's
 * `totalConsumptionForTenant` follows for exactly this reason. `evaluateTenantQuota` is still what computes the
 * headroom, so the customer's figures and the enforcement path can never disagree about their allocation.
 *
 * `resultsReady` requires both that the loop is done and that a payload actually exists, so the dashboard never
 * invites a customer to "see results" that are not there yet.
 */
export function buildCustomerLoopView(input: CustomerLoopViewInput): CustomerLoopView {
  const used = totalConsumptionForTenant(input.consumption ?? [], input.tenantId);
  const quota = input.quota ?? null;
  // activeLoops is the identity here, not a measurement: the concurrency verdict is discarded below, and both
  // spend dimensions' headroom is independent of it.
  const decision = quota === null ? null : evaluateTenantQuota({ ...used, activeLoops: 0 }, quota);
  const results = input.results ?? null;

  return {
    loopId: input.loopId,
    progress: input.progress,
    spend: {
      computeUnitsUsed: used.computeUnitsUsed,
      wallClockMsUsed: used.wallClockMsUsed,
      remaining:
        decision === null
          ? null
          : { computeUnits: decision.remaining.computeUnits, wallClockMs: decision.remaining.wallClockMs },
      withinQuota: decision === null ? null : decision.exceeded !== "compute" && decision.exceeded !== "time",
    },
    results,
    resultsReady: input.progress.done && results !== null,
  };
}

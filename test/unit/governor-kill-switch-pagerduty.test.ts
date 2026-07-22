// Pure-builder tests for buildMinerKillSwitchPagerDutyAlert (#7666) -- the PagerDuty-paging counterpart to
// buildMinerKillSwitchTransitionGovernorLedgerEvent (see governor-run-halt.test.ts / kill-switch-incident-
// runbook.test.ts for the same "test the engine's pure calculator directly" convention). The IO wrapper that
// actually fires the Events API v2 call (packages/loopover-miner/lib/governor-kill-switch.ts's
// notifyMinerKillSwitchPagerDuty) is covered by test/unit/miner-governor-kill-switch.test.ts.
import { describe, expect, it } from "vitest";
import { buildMinerKillSwitchPagerDutyAlert } from "../../packages/loopover-engine/src/governor/kill-switch";

describe("buildMinerKillSwitchPagerDutyAlert (#7666)", () => {
  it("no-op when the scope has not changed", () => {
    expect(buildMinerKillSwitchPagerDutyAlert({ actionClass: "open_pr", previousScope: "none", scope: "none" })).toBeNull();
    expect(buildMinerKillSwitchPagerDutyAlert({ actionClass: "open_pr", previousScope: "repo", scope: "repo" })).toBeNull();
    expect(buildMinerKillSwitchPagerDutyAlert({ actionClass: "open_pr", previousScope: "global", scope: "global" })).toBeNull();
  });

  it("no-op on a resume transition (a transition INTO 'none') -- only a trip pages, never a resume", () => {
    expect(
      buildMinerKillSwitchPagerDutyAlert({
        repoFullName: "acme/widgets",
        actionClass: "open_pr",
        previousScope: "repo",
        scope: "none",
      }),
    ).toBeNull();
    expect(buildMinerKillSwitchPagerDutyAlert({ actionClass: "open_pr", previousScope: "global", scope: "none" })).toBeNull();
  });

  it("a repo trip builds a critical alert with a repo-scoped dedup key and component", () => {
    const alert = buildMinerKillSwitchPagerDutyAlert({
      repoFullName: "acme/widgets",
      actionClass: "open_pr",
      previousScope: "none",
      scope: "repo",
    });
    expect(alert).toEqual({
      repoFullName: "acme/widgets",
      scope: "repo",
      actionClass: "open_pr",
      summary: "AMS miner kill-switch tripped (repo) — open_pr halted for acme/widgets",
      severity: "critical",
      dedupKey: "miner_kill_switch_tripped:repo:acme/widgets",
      customDetails: { scope: "repo", previousScope: "none", repoFullName: "acme/widgets", actionClass: "open_pr" },
    });
  });

  it("a global trip with no repoFullName supplied dedups/reports on the literal 'global' target, not null or omitted", () => {
    const alert = buildMinerKillSwitchPagerDutyAlert({
      actionClass: "open_pr",
      previousScope: "none",
      scope: "global",
    });
    expect(alert).toEqual({
      repoFullName: null,
      scope: "global",
      actionClass: "open_pr",
      summary: "AMS miner kill-switch tripped (global) — open_pr halted for global",
      severity: "critical",
      dedupKey: "miner_kill_switch_tripped:global:global",
      customDetails: { scope: "global", previousScope: "none", repoFullName: null, actionClass: "open_pr" },
    });
  });

  it("REGRESSION: a global trip that also carries a repoFullName still dedups per-repo, matching component", () => {
    // Not a real-world combination (global halts every repo at once) but the builder must not silently drop
    // an unexpectedly-present repoFullName -- it should behave identically to the repo-scope case for targeting.
    const alert = buildMinerKillSwitchPagerDutyAlert({
      repoFullName: "acme/widgets",
      actionClass: "open_pr",
      previousScope: "none",
      scope: "global",
    });
    expect(alert?.dedupKey).toBe("miner_kill_switch_tripped:global:acme/widgets");
    expect(alert?.repoFullName).toBe("acme/widgets");
  });
});

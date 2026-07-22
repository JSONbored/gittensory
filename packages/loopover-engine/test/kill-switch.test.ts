import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MINER_KILL_SWITCH_ENV_VAR,
  buildMinerKillSwitchPagerDutyAlert,
  buildMinerKillSwitchTransitionGovernorLedgerEvent,
  isGlobalMinerKillSwitch,
  isMinerKillSwitchActive,
  resolveMinerKillSwitch,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the kill-switch primitive (#2341)", () => {
  assert.equal(typeof isGlobalMinerKillSwitch, "function");
  assert.equal(typeof resolveMinerKillSwitch, "function");
  assert.equal(typeof isMinerKillSwitchActive, "function");
  assert.equal(typeof buildMinerKillSwitchTransitionGovernorLedgerEvent, "function");
  assert.equal(typeof buildMinerKillSwitchPagerDutyAlert, "function");
  assert.equal(MINER_KILL_SWITCH_ENV_VAR, "LOOPOVER_MINER_KILL_SWITCH");
});

test("isGlobalMinerKillSwitch: accepts the same truthy-string idiom as isGlobalAgentPause", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", "On"]) {
    assert.equal(isGlobalMinerKillSwitch({ LOOPOVER_MINER_KILL_SWITCH: value }), true, `expected ${value} to be truthy`);
  }
  for (const value of [undefined, "", "0", "false", "no", "off", "banana"]) {
    assert.equal(isGlobalMinerKillSwitch({ LOOPOVER_MINER_KILL_SWITCH: value }), false, `expected ${String(value)} to be falsy`);
  }
});

test("resolveMinerKillSwitch: global denies regardless of per-repo state", () => {
  assert.equal(resolveMinerKillSwitch({ global: true, repoPaused: false }), "global");
  assert.equal(resolveMinerKillSwitch({ global: true, repoPaused: true }), "global");
  assert.equal(resolveMinerKillSwitch({ global: true, repoPaused: undefined }), "global");
});

test("resolveMinerKillSwitch: per-repo pause denies only when global is not tripped", () => {
  assert.equal(resolveMinerKillSwitch({ global: false, repoPaused: true }), "repo");
  assert.equal(resolveMinerKillSwitch({ global: false, repoPaused: false }), "none");
  assert.equal(resolveMinerKillSwitch({ global: false, repoPaused: undefined }), "none");
});

test("resolveMinerKillSwitch: toggling off resumes immediately with no residual state (pure/stateless)", () => {
  const pausedRepoA = resolveMinerKillSwitch({ global: false, repoPaused: true });
  const resumedRepoA = resolveMinerKillSwitch({ global: false, repoPaused: false });
  const stillPausedRepoB = resolveMinerKillSwitch({ global: false, repoPaused: true });
  assert.equal(pausedRepoA, "repo");
  assert.equal(resumedRepoA, "none");
  // Resuming repo A must not leak into a separate repo's independently-tracked pause state.
  assert.equal(stillPausedRepoB, "repo");
});

test("isMinerKillSwitchActive: true for any active scope, false only for none", () => {
  assert.equal(isMinerKillSwitchActive("global"), true);
  assert.equal(isMinerKillSwitchActive("repo"), true);
  assert.equal(isMinerKillSwitchActive("none"), false);
});

test("buildMinerKillSwitchTransitionGovernorLedgerEvent: no-op when the scope has not changed", () => {
  assert.equal(
    buildMinerKillSwitchTransitionGovernorLedgerEvent({
      actionClass: "open_pr",
      previousScope: "none",
      scope: "none",
    }),
    null,
  );
  assert.equal(
    buildMinerKillSwitchTransitionGovernorLedgerEvent({
      actionClass: "open_pr",
      previousScope: "global",
      scope: "global",
    }),
    null,
  );
});

test("buildMinerKillSwitchTransitionGovernorLedgerEvent: engaging the switch records a tripped kill_switch event", () => {
  const event = buildMinerKillSwitchTransitionGovernorLedgerEvent({
    repoFullName: "acme/widgets",
    actionClass: "open_pr",
    previousScope: "none",
    scope: "repo",
  });
  assert.deepEqual(event, {
    eventType: "kill_switch",
    repoFullName: "acme/widgets",
    actionClass: "open_pr",
    decision: "tripped",
    reason: "repo_kill_switch_engaged",
    payload: { previousScope: "none", scope: "repo" },
  });
});

test("buildMinerKillSwitchTransitionGovernorLedgerEvent: clearing the switch records a resumed kill_switch event", () => {
  const event = buildMinerKillSwitchTransitionGovernorLedgerEvent({
    actionClass: "open_pr",
    previousScope: "global",
    scope: "none",
  });
  assert.deepEqual(event, {
    eventType: "kill_switch",
    repoFullName: null,
    actionClass: "open_pr",
    decision: "resumed",
    reason: "global_kill_switch_cleared",
    payload: { previousScope: "global", scope: "none" },
  });
});

test("buildMinerKillSwitchPagerDutyAlert: no-op when the scope has not changed (#7666)", () => {
  assert.equal(
    buildMinerKillSwitchPagerDutyAlert({ actionClass: "open_pr", previousScope: "none", scope: "none" }),
    null,
  );
  assert.equal(
    buildMinerKillSwitchPagerDutyAlert({ actionClass: "open_pr", previousScope: "repo", scope: "repo" }),
    null,
  );
});

test("buildMinerKillSwitchPagerDutyAlert: no-op on a resume transition -- only a trip pages (#7666)", () => {
  assert.equal(
    buildMinerKillSwitchPagerDutyAlert({
      repoFullName: "acme/widgets",
      actionClass: "open_pr",
      previousScope: "repo",
      scope: "none",
    }),
    null,
  );
  assert.equal(
    buildMinerKillSwitchPagerDutyAlert({ actionClass: "open_pr", previousScope: "global", scope: "none" }),
    null,
  );
});

test("buildMinerKillSwitchPagerDutyAlert: a repo trip builds a critical alert with a repo-scoped dedup key (#7666)", () => {
  const alert = buildMinerKillSwitchPagerDutyAlert({
    repoFullName: "acme/widgets",
    actionClass: "open_pr",
    previousScope: "none",
    scope: "repo",
  });
  assert.deepEqual(alert, {
    repoFullName: "acme/widgets",
    scope: "repo",
    actionClass: "open_pr",
    summary: "AMS miner kill-switch tripped (repo) — open_pr halted for acme/widgets",
    severity: "critical",
    dedupKey: "miner_kill_switch_tripped:repo:acme/widgets",
    customDetails: { scope: "repo", previousScope: "none", repoFullName: "acme/widgets", actionClass: "open_pr" },
  });
});

test("buildMinerKillSwitchPagerDutyAlert: a global trip with no repoFullName dedups on 'global', not null (#7666)", () => {
  const alert = buildMinerKillSwitchPagerDutyAlert({
    actionClass: "open_pr",
    previousScope: "none",
    scope: "global",
  });
  assert.deepEqual(alert, {
    repoFullName: null,
    scope: "global",
    actionClass: "open_pr",
    summary: "AMS miner kill-switch tripped (global) — open_pr halted for global",
    severity: "critical",
    dedupKey: "miner_kill_switch_tripped:global:global",
    customDetails: { scope: "global", previousScope: "none", repoFullName: null, actionClass: "open_pr" },
  });
});

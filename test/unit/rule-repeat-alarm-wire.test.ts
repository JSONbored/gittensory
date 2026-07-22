import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RULE_REPEAT_ALARM_THRESHOLD,
  recordGateBlockersAndCheckRepeatAlarm,
} from "../../src/review/rule-repeat-alarm-wire";
import * as repositories from "../../src/db/repositories";
import { hasRecentAuditEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const REPO = "metagraphed/metagraphed";

afterEach(() => {
  vi.restoreAllMocks();
});

async function fireOnce(env: ReturnType<typeof createTestEnv>, pullNumber: number, blockerCodes: string[], occurredAt: string) {
  await recordGateBlockersAndCheckRepeatAlarm(env, { repoFullName: REPO, pullNumber, blockerCodes, occurredAt });
}

describe("recordGateBlockersAndCheckRepeatAlarm (#7983)", () => {
  it("does nothing at all for an empty blockerCodes list", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await recordGateBlockersAndCheckRepeatAlarm(env, { repoFullName: REPO, pullNumber: 1, blockerCodes: [] });
    expect(error).not.toHaveBeenCalled();
  });

  it("does not alert below the threshold", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    for (let i = 1; i < RULE_REPEAT_ALARM_THRESHOLD; i++) {
      await fireOnce(env, i, ["surface_lane_reject"], new Date(now).toISOString());
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("replays the #7469/#7589/#7591/#7594 incident shape: alerts once the 3rd distinct PR is blocked by the same code", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    await fireOnce(env, 7469, ["surface_lane_reject"], new Date(now).toISOString());
    expect(error).not.toHaveBeenCalled();
    await fireOnce(env, 7589, ["surface_lane_reject"], new Date(now + 1000).toISOString());
    expect(error).not.toHaveBeenCalled();
    await fireOnce(env, 7591, ["surface_lane_reject"], new Date(now + 2000).toISOString());
    expect(error).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(error.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      level: "error",
      event: "same_rule_repeat_alarm",
      repo: REPO,
      blockerCode: "surface_lane_reject",
      distinctTargetCount: 3,
      threshold: RULE_REPEAT_ALARM_THRESHOLD,
    });
    expect(payload.affectedTargets).toEqual([
      `${REPO}#7469`,
      `${REPO}#7589`,
      `${REPO}#7591`,
    ]);
  });

  it("records the trigger as a queryable audit event", async () => {
    const env = createTestEnv();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    for (let i = 1; i <= RULE_REPEAT_ALARM_THRESHOLD; i++) {
      await fireOnce(env, i, ["surface_lane_reject"], new Date(now + i).toISOString());
    }
    const found = await hasRecentAuditEvent(
      env,
      "loopover",
      `rule_repeat_alarm:${REPO}:surface_lane_reject`,
      new Date(now - 60_000).toISOString(),
    );
    expect(found).toBe(true);
  });

  it("does not re-alert for a 4th PR once already triggered within the cooldown window", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    for (let i = 1; i <= RULE_REPEAT_ALARM_THRESHOLD; i++) {
      await fireOnce(env, i, ["surface_lane_reject"], new Date(now + i).toISOString());
    }
    expect(error).toHaveBeenCalledTimes(1);
    await fireOnce(env, 999, ["surface_lane_reject"], new Date(now + 5000).toISOString());
    expect(error).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("scopes the alarm PER REPO — a different repo's PRs never contribute to or trigger another repo's count", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    await recordGateBlockersAndCheckRepeatAlarm(env, { repoFullName: "acme/widgets", pullNumber: 1, blockerCodes: ["surface_lane_reject"], occurredAt: new Date(now).toISOString() });
    await recordGateBlockersAndCheckRepeatAlarm(env, { repoFullName: "acme/gizmos", pullNumber: 1, blockerCodes: ["surface_lane_reject"], occurredAt: new Date(now).toISOString() });
    await recordGateBlockersAndCheckRepeatAlarm(env, { repoFullName: "acme/widgets", pullNumber: 2, blockerCodes: ["surface_lane_reject"], occurredAt: new Date(now).toISOString() });
    // Only 2 distinct targets for "acme/widgets", 1 for "acme/gizmos" -- neither crosses 3 alone even though
    // 3 total blocks happened across the fleet.
    expect(error).not.toHaveBeenCalled();
  });

  it("scopes the alarm PER BLOCKER CODE — a different code on the same repo never contributes to another code's count", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    await fireOnce(env, 1, ["surface_lane_reject"], new Date(now).toISOString());
    await fireOnce(env, 2, ["missing_linked_issue"], new Date(now).toISOString());
    await fireOnce(env, 3, ["surface_lane_reject"], new Date(now).toISOString());
    // "surface_lane_reject" only has 2 distinct targets (#1, #3); "missing_linked_issue" only has 1 (#2).
    expect(error).not.toHaveBeenCalled();
  });

  it("dedupes multiple identical blocker codes in the SAME call into one fired signal, not one per duplicate", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    // A single PR whose gate blockers list happens to repeat the same code twice must still only count as ONE
    // distinct target toward that code's alarm, not two.
    await fireOnce(env, 1, ["surface_lane_reject", "surface_lane_reject"], new Date(now).toISOString());
    await fireOnce(env, 2, ["surface_lane_reject"], new Date(now + 1000).toISOString());
    expect(error).not.toHaveBeenCalled(); // only 2 distinct PRs total, below threshold 3
  });

  it("independently tracks and alerts on multiple DIFFERENT blocker codes in the same call", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    for (let i = 1; i <= RULE_REPEAT_ALARM_THRESHOLD; i++) {
      await fireOnce(env, i, ["code_a", "code_b"], new Date(now + i).toISOString());
    }
    // Both code_a and code_b independently crossed the threshold across the same 3 PRs.
    expect(error).toHaveBeenCalledTimes(2);
    const events = error.mock.calls.map((call) => JSON.parse(String(call[0])).blockerCode).sort();
    expect(events).toEqual(["code_a", "code_b"]);
  });

  it("a store failure is swallowed, never thrown into the caller (best-effort, must never affect the gate decision)", async () => {
    const env = { ...createTestEnv(), DB: null } as unknown as ReturnType<typeof createTestEnv>;
    await expect(
      recordGateBlockersAndCheckRepeatAlarm(env, { repoFullName: REPO, pullNumber: 1, blockerCodes: ["surface_lane_reject"] }),
    ).resolves.toBeUndefined();
  });

  it("swallows a failure writing the alert-marker audit event -- the trigger itself must never throw even if only that specific write fails", async () => {
    const env = createTestEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const realRecordAuditEvent = repositories.recordAuditEvent;
    vi.spyOn(repositories, "recordAuditEvent").mockImplementation(async (e, event) => {
      if (event.eventType.startsWith("rule_repeat_alarm:")) throw new Error("write failed");
      return realRecordAuditEvent(e, event);
    });
    const now = Date.now();
    for (let i = 1; i <= RULE_REPEAT_ALARM_THRESHOLD; i++) {
      await fireOnce(env, i, ["surface_lane_reject"], new Date(now + i).toISOString());
    }
    // The alert still logs (console.error happens before the audit-marker write), and the whole call still
    // resolves cleanly despite the marker write failing.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("defaults occurredAt to the current time when omitted", async () => {
    const env = createTestEnv();
    const before = Date.now();
    await recordGateBlockersAndCheckRepeatAlarm(env, { repoFullName: REPO, pullNumber: 1, blockerCodes: ["surface_lane_reject"] });
    const after = Date.now();
    const { createSignalStore } = await import("../../src/review/signal-tracking-wire");
    const history = await createSignalStore(env).queryRuleHistory(`${REPO}:surface_lane_reject`, before - 1000);
    expect(history.fired).toHaveLength(1);
    const occurredAtMs = new Date(history.fired[0]?.occurredAt ?? "").getTime();
    expect(occurredAtMs).toBeGreaterThanOrEqual(before);
    expect(occurredAtMs).toBeLessThanOrEqual(after);
  });
});

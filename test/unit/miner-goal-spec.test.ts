import { describe, expect, it } from "vitest";
import { DEFAULT_MINER_GOAL_SPEC, type MinerGoalSpec } from "../../src/signals/miner-goal-spec";

describe("MinerGoalSpec", () => {
  it("exports safe defaults matching the declared type contract", () => {
    const typed: MinerGoalSpec = DEFAULT_MINER_GOAL_SPEC;
    expect(typed).toEqual({
      minerEnabled: true,
      wantedPaths: [],
      blockedPaths: [],
      preferredLabels: [],
      maxConcurrentClaims: 1,
      issueDiscoveryPolicy: "neutral",
    });
  });

  it("documents the default for every field in a co-located comment", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("src/signals/miner-goal-spec.ts", "utf8"));
    expect(source).toMatch(/Whether autonomous miners may target this repo\. Default: true\./);
    expect(source).toMatch(/Preferred work areas for miner-created changes\. Glob list\. Default: \[\]\./);
    expect(source).toMatch(/Paths miners should avoid touching\. Glob list\. Default: \[\]\./);
    expect(source).toMatch(/Labels miners should prefer when selecting or filing work\. Default: \[\]\./);
    expect(source).toMatch(/Maximum concurrent claims a miner should hold against this repo\. Default: 1\./);
    expect(source).toMatch(/Whether issue discovery work is encouraged for the repo\. Default: neutral\./);
  });
});

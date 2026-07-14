import { describe, expect, it } from "vitest";
// #4882: the pure PR-target-key parser now lives in loopover-engine, extracted out of the D1-heavy
// repositories access layer. This suite drives it through the engine's public barrel and exercises every
// branch so the moved code carries its own coverage.
import { parsePullRequestTargetKey } from "../../packages/loopover-engine/src/index";

describe("parsePullRequestTargetKey (#4882)", () => {
  it("returns null for falsy input", () => {
    expect(parsePullRequestTargetKey(null)).toBeNull();
    expect(parsePullRequestTargetKey(undefined)).toBeNull();
    expect(parsePullRequestTargetKey("")).toBeNull();
  });

  it("returns null when there is no '#', or it is leading or trailing", () => {
    expect(parsePullRequestTargetKey("owner/repo")).toBeNull();
    expect(parsePullRequestTargetKey("#5")).toBeNull();
    expect(parsePullRequestTargetKey("owner/repo#")).toBeNull();
  });

  it("returns null when the repo half has no '/'", () => {
    expect(parsePullRequestTargetKey("owner#5")).toBeNull();
  });

  it("returns null when the pull number is not a positive integer", () => {
    expect(parsePullRequestTargetKey("owner/repo#abc")).toBeNull();
    expect(parsePullRequestTargetKey("owner/repo#1.5")).toBeNull();
    expect(parsePullRequestTargetKey("owner/repo#0")).toBeNull();
    expect(parsePullRequestTargetKey("owner/repo#-3")).toBeNull();
  });

  it("parses a well-formed target key", () => {
    expect(parsePullRequestTargetKey("owner/repo#42")).toEqual({
      repoFullName: "owner/repo",
      pullNumber: 42,
    });
  });

  it("splits on the last '#' so a repo name containing '#' still parses", () => {
    expect(parsePullRequestTargetKey("owner/re#po#7")).toEqual({
      repoFullName: "owner/re#po",
      pullNumber: 7,
    });
  });
});

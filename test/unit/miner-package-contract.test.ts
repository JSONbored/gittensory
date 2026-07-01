import { describe, expect, it } from "vitest";

describe("miner package workspace contracts", () => {
  it("allows importing @jsonbored/gittensory-engine by package name", async () => {
    const mod = await import("@jsonbored/gittensory-engine");
    expect(Object.keys(mod)).toEqual([]);
  });
});

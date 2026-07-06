import { describe, expect, it } from "vitest";
import { compareCapturedScreenshots, isVisualDiffAvailable } from "../../src/review/visual/pixel-diff";

describe("pixel-diff Worker-safe default (#3674)", () => {
  it("reports diffing as unavailable", () => {
    expect(isVisualDiffAvailable()).toBe(false);
  });

  it("always resolves to null regardless of input, since the real implementation is self-host only", async () => {
    const before = new Uint8Array([1, 2, 3]);
    const after = new Uint8Array([4, 5, 6]);
    await expect(compareCapturedScreenshots(before, after)).resolves.toBeNull();
    await expect(compareCapturedScreenshots(before, undefined)).resolves.toBeNull();
    await expect(compareCapturedScreenshots(null, after)).resolves.toBeNull();
    await expect(compareCapturedScreenshots(null, null)).resolves.toBeNull();
  });
});

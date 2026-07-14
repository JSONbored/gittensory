import { describe, expect, it } from "vitest";

import { buildPredictedGateVerdict, type PredictedGateInput } from "../../packages/loopover-engine/src/predicted-gate";

describe("gittensory-engine predicted-gate barrel exports (#2283)", () => {
  it("re-exports predicted-gate symbols from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.buildPredictedGateVerdict).toBe("function");
    expect(typeof buildPredictedGateVerdict).toBe("function");
    const input: PredictedGateInput = {
      repoFullName: "acme/widget",
      contributorLogin: "dev",
      title: "Fix widget",
    };
    expect(typeof barrel.buildPredictedGateVerdict).toBe(typeof buildPredictedGateVerdict);
    expect(input.repoFullName).toBe("acme/widget");
  });
});

import { describe, expect, it } from "vitest";
import { extractObjectiveAnchorFeatures } from "../../packages/loopover-engine/src/objective-anchor";

// packages/loopover-engine/src/objective-anchor.ts's CONFIG_FILENAMES set is exercised almost
// exclusively by its own node:test suite (invisible to Codecov's vitest-based coverage), so
// classifying ".loopover.yml" needs a real vitest-side assertion, not just a top-level module-load hit.
describe("gittensory-engine objective-anchor config-filename classification", () => {
  it("classifies .loopover.yml as a 'config' change kind", () => {
    const features = extractObjectiveAnchorFeatures({
      paths: [".loopover.yml"],
      labels: [],
      titles: [],
      notes: [],
    });

    expect(features.changeKinds).toContain("config");
    expect(features.paths).toEqual([".loopover.yml"]);
  });
});

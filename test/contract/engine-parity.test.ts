/**
 * Golden-snapshot parity suite for predicted-gate (#2286).
 *
 * Each fixture under `test/fixtures/engine-parity/predicted-gate/` is run through the public
 * `buildPredictedGateVerdict` re-export surface (`src/rules/predicted-gate.ts`) and compared
 * byte-for-byte against a committed golden JSON in `golden/`. This catches silent drift when
 * engine extraction or refactors change gate output without updating fixtures.
 *
 * To intentionally refresh goldens after a deliberate gate-behavior change, run:
 * `npx tsx scripts/record-engine-parity-goldens.ts`
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildPredictedGateVerdict } from "../../src/rules/predicted-gate";
import { predictedGateFixtures } from "../fixtures/engine-parity/predicted-gate";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "engine-parity", "predicted-gate");
const GOLDEN_DIR = join(FIXTURE_DIR, "golden");

describe("predicted-gate engine parity (#2286)", () => {
  it("has one committed golden per scenario fixture", () => {
    const scenarioFiles = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(".ts") && name !== "index.ts" && !name.startsWith("_"))
      .sort();
    const goldenFiles = readdirSync(GOLDEN_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();

    expect(goldenFiles).toEqual(scenarioFiles.map((name) => name.replace(/\.ts$/, ".json")));
    expect(predictedGateFixtures).toHaveLength(scenarioFiles.length);
  });

  it.each(predictedGateFixtures)("$id matches the committed golden output", (fixture) => {
    const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, `${fixture.id}.json`), "utf8"));
    const verdict = buildPredictedGateVerdict({
      input: fixture.input,
      manifest: fixture.manifest,
      repo: fixture.repo,
      issues: fixture.issues,
      pullRequests: fixture.pullRequests,
      ...(fixture.changedPaths ? { changedPaths: fixture.changedPaths } : {}),
    });

    expect(verdict).toEqual(golden);
  });
});

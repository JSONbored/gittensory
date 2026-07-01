import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPredictedGateVerdict } from "../../src/rules/predicted-gate";
import { predictedGateFixtures } from "../fixtures/engine-parity/predicted-gate";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "engine-parity", "predicted-gate");

describe("predicted-gate engine parity fixtures", () => {
  it("exports every scenario file through the fixture index", () => {
    const scenarioFiles = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(".ts") && name !== "index.ts" && !name.startsWith("_"))
      .sort();

    expect(predictedGateFixtures).toHaveLength(scenarioFiles.length);
    expect(predictedGateFixtures.map((fixture) => `${fixture.id}.ts`).sort()).toEqual(scenarioFiles);
  });

  it.each(predictedGateFixtures)("keeps the $id fixture parseable and aligned with its documented surface", (fixture) => {
    const result = buildPredictedGateVerdict({
      input: fixture.input,
      manifest: fixture.manifest,
      repo: fixture.repo,
      issues: fixture.issues,
      pullRequests: fixture.pullRequests,
      ...(fixture.changedPaths ? { changedPaths: fixture.changedPaths } : {}),
    });

    expect(result.conclusion).toBe(fixture.expected.conclusion);
    expect(result.pack).toBe(fixture.expected.pack);
    expect(result.blockers.map((finding) => finding.code).sort()).toEqual([...fixture.expected.blockerCodes].sort());
    expect(result.warnings.map((finding) => finding.code).sort()).toEqual([...fixture.expected.warningCodes].sort());
    expect(result.funnel !== null).toBe(fixture.expected.funnelPresent);

    for (const snippet of fixture.expected.noteIncludes ?? []) {
      expect(result.note).toContain(snippet);
    }
    for (const snippet of fixture.expected.noteExcludes ?? []) {
      expect(result.note).not.toContain(snippet);
    }
  });
});

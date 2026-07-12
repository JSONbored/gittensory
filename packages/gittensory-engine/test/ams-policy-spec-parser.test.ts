import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AMS_POLICY_SPEC_FILENAMES,
  DEFAULT_AMS_POLICY_SPEC,
  parseAmsPolicySpec,
  parseAmsPolicySpecContent,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the AmsPolicySpec parser API", () => {
  assert.equal(typeof parseAmsPolicySpec, "function");
  assert.equal(typeof parseAmsPolicySpecContent, "function");
  assert.deepEqual(AMS_POLICY_SPEC_FILENAMES, [
    ".gittensory-ams.yml",
    ".github/gittensory-ams.yml",
    ".gittensory-ams.json",
    ".github/gittensory-ams.json",
  ]);
});

test("parseAmsPolicySpec: missing raw input returns an absent safe-default spec with no warnings", () => {
  const parsed = parseAmsPolicySpec(undefined);
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.spec, DEFAULT_AMS_POLICY_SPEC);
  assert.deepEqual(parsed.warnings, []);
});

test("parseAmsPolicySpec: a non-mapping raw value degrades to safe defaults with a warning", () => {
  const parsed = parseAmsPolicySpec(["not", "a", "mapping"]);
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.spec, DEFAULT_AMS_POLICY_SPEC);
  assert.match(parsed.warnings.join(" "), /must be a mapping/i);
});

test("parseAmsPolicySpec: valid raw config normalizes every field and keeps non-default input present", () => {
  const parsed = parseAmsPolicySpec({
    submissionMode: "enforce",
    slopThreshold: "clean",
    capLimits: { budget: 10, turns: 40, elapsedMs: 3_600_000 },
    convergenceThresholds: { maxConsecutiveFailures: 5, maxReenqueues: 2 },
  });

  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.spec, {
    submissionMode: "enforce",
    slopThreshold: "clean",
    capLimits: { budget: 10, turns: 40, elapsedMs: 3_600_000 },
    convergenceThresholds: { maxConsecutiveFailures: 5, maxReenqueues: 2 },
  });
  assert.deepEqual(parsed.warnings, []);
});

test("parseAmsPolicySpec: submissionMode rejects an unrecognized value", () => {
  const parsed = parseAmsPolicySpec({ submissionMode: "yolo" });
  assert.equal(parsed.spec.submissionMode, "observe");
  assert.match(parsed.warnings.join(" "), /submissionMode.*observe, enforce/i);
});

test("parseAmsPolicySpec: slopThreshold rejects an unrecognized value", () => {
  const parsed = parseAmsPolicySpec({ slopThreshold: "spicy" });
  assert.equal(parsed.spec.slopThreshold, "low");
  assert.match(parsed.warnings.join(" "), /slopThreshold.*clean, low, elevated, high/i);
});

test("parseAmsPolicySpec: capLimits normalizes independently, rejects negative/non-numeric fields, and rejects a non-mapping value", () => {
  const valid = parseAmsPolicySpec({ capLimits: { budget: 1, turns: 2, elapsedMs: 3 } });
  assert.deepEqual(valid.spec.capLimits, { budget: 1, turns: 2, elapsedMs: 3 });
  assert.deepEqual(valid.warnings, []);

  const negative = parseAmsPolicySpec({ capLimits: { budget: -1 } });
  assert.equal(negative.spec.capLimits.budget, DEFAULT_AMS_POLICY_SPEC.capLimits.budget);
  assert.match(negative.warnings.join(" "), /capLimits\.budget/i);

  const nonNumeric = parseAmsPolicySpec({ capLimits: { turns: "many" } });
  assert.equal(nonNumeric.spec.capLimits.turns, DEFAULT_AMS_POLICY_SPEC.capLimits.turns);
  assert.match(nonNumeric.warnings.join(" "), /capLimits\.turns/i);

  const arrayValue = parseAmsPolicySpec({ capLimits: ["not", "a", "mapping"] });
  assert.deepEqual(arrayValue.spec.capLimits, DEFAULT_AMS_POLICY_SPEC.capLimits);
  assert.match(arrayValue.warnings.join(" "), /capLimits.*must be a mapping/i);
});

test("parseAmsPolicySpec: convergenceThresholds normalizes independently and rejects a non-mapping value", () => {
  const valid = parseAmsPolicySpec({ convergenceThresholds: { maxConsecutiveFailures: 1, maxReenqueues: 1 } });
  assert.deepEqual(valid.spec.convergenceThresholds, { maxConsecutiveFailures: 1, maxReenqueues: 1 });

  const arrayValue = parseAmsPolicySpec({ convergenceThresholds: ["nope"] });
  assert.deepEqual(arrayValue.spec.convergenceThresholds, DEFAULT_AMS_POLICY_SPEC.convergenceThresholds);
  assert.match(arrayValue.warnings.join(" "), /convergenceThresholds.*must be a mapping/i);
});

test("parseAmsPolicySpecContent: JSON and YAML both parse, malformed content degrades to safe defaults", () => {
  const fromJson = parseAmsPolicySpecContent(JSON.stringify({ submissionMode: "enforce" }));
  assert.equal(fromJson.present, true);
  assert.equal(fromJson.spec.submissionMode, "enforce");

  const fromYaml = parseAmsPolicySpecContent("submissionMode: enforce\nslopThreshold: clean\n");
  assert.equal(fromYaml.present, true);
  assert.equal(fromYaml.spec.submissionMode, "enforce");
  assert.equal(fromYaml.spec.slopThreshold, "clean");

  const emptyContent = parseAmsPolicySpecContent("");
  assert.equal(emptyContent.present, false);
  assert.deepEqual(emptyContent.warnings, []);

  const nullContent = parseAmsPolicySpecContent(null);
  assert.equal(nullContent.present, false);

  const malformedJson = parseAmsPolicySpecContent("{ not valid json");
  assert.equal(malformedJson.present, false);
  assert.match(malformedJson.warnings.join(" "), /not valid JSON/i);

  const malformedYaml = parseAmsPolicySpecContent("submissionMode: [unterminated");
  assert.equal(malformedYaml.present, false);
  assert.match(malformedYaml.warnings.join(" "), /not valid YAML/i);

  const oversized = parseAmsPolicySpecContent("submissionMode: enforce\n# padding\n" + "x".repeat(9_000));
  assert.equal(oversized.present, false);
  assert.match(oversized.warnings.join(" "), /exceeded/i);
});

import { describe, expect, it } from "vitest";
import { MAX_FOCUS_MANIFEST_BYTES, RETIRED_FIELD_MIGRATION_WARNINGS, TOP_LEVEL_FIELDS, unknownTopLevelWarnings } from "../../src/signals/focus-manifest";

// Exhaustive coverage of the shared unknown-top-level-field detector extracted (#5929) from
// src/selfhost/config-lint.ts into packages/loopover-engine/src/focus-manifest.ts, so both
// src/selfhost/config-lint.ts and src/services/focus-manifest-validation.ts can import the same
// allowlist and detection logic instead of drifting independently.
describe("unknownTopLevelWarnings (#5929)", () => {
  it("exposes the shared top-level field allowlist and retired-field migration map", () => {
    expect(TOP_LEVEL_FIELDS).toContain("wantedPaths");
    expect(TOP_LEVEL_FIELDS).toContain("gate");
    expect(RETIRED_FIELD_MIGRATION_WARNINGS.blockedPaths).toBe("blockedPaths is retired; use settings.hardGuardrailGlobs for path holds.");
  });

  it("returns no warnings when every top-level key is recognized", () => {
    expect(unknownTopLevelWarnings("wantedPaths: [src/]\ngate:\n  enabled: true\n")).toEqual([]);
  });

  it("returns no warnings for empty/undefined/null/blank content", () => {
    expect(unknownTopLevelWarnings(undefined)).toEqual([]);
    expect(unknownTopLevelWarnings(null)).toEqual([]);
    expect(unknownTopLevelWarnings("")).toEqual([]);
    expect(unknownTopLevelWarnings("   \n  ")).toEqual([]);
  });

  it("warns (singular) on exactly one unknown top-level field", () => {
    expect(unknownTopLevelWarnings("wantedPaths: [src/]\ngates:\n  enabled: true\n")).toEqual([
      "Manifest contains unknown top-level field: gates.",
    ]);
  });

  it("warns (plural) on multiple unknown top-level fields", () => {
    expect(unknownTopLevelWarnings("gates: true\npreferedLabels: [x]\n")).toEqual([
      "Manifest contains unknown top-level fields: gates, preferedLabels.",
    ]);
  });

  it("emits the migration-specific warning for a retired field instead of the generic message", () => {
    expect(unknownTopLevelWarnings("blockedPaths: [dist/]\n")).toEqual([
      "blockedPaths is retired; use settings.hardGuardrailGlobs for path holds.",
    ]);
  });

  it("emits both a retired-field warning and a distinct unknown-field warning together", () => {
    expect(unknownTopLevelWarnings("blockedPaths: [dist/]\nunknownSecretKey: [x]\n")).toEqual([
      "blockedPaths is retired; use settings.hardGuardrailGlobs for path holds.",
      "Manifest contains unknown top-level field: unknownSecretKey.",
    ]);
  });

  it("sanitizes an unsafe or blank field name instead of echoing it verbatim", () => {
    const result = unknownTopLevelWarnings('"": blank-field-name\n"private path": /tmp/private\n');
    expect(result).toEqual(["Manifest contains unknown top-level fields: <blank>, private_path."]);
  });

  it("treats a field named like an Object.prototype member as unknown, not retired", () => {
    const result = unknownTopLevelWarnings("constructor: whatever\n");
    expect(result).toEqual(["Manifest contains unknown top-level field: constructor."]);
    expect(result.every((warning) => typeof warning === "string")).toBe(true);
  });

  it("falls back from JSON.parse to YAML for a flow mapping that starts like JSON", () => {
    expect(unknownTopLevelWarnings("{wantedPaths: [src/], unknownSecretKey: secret}")).toEqual([
      "Manifest contains unknown top-level field: unknownSecretKey.",
    ]);
  });

  it("returns no warnings for malformed YAML content", () => {
    expect(unknownTopLevelWarnings("wantedPaths: [unterminated")).toEqual([]);
  });

  it("returns no warnings for a top-level array", () => {
    expect(unknownTopLevelWarnings("[]")).toEqual([]);
    expect(unknownTopLevelWarnings("- one\n- two\n")).toEqual([]);
  });

  it("returns no warnings for a top-level null or bare scalar", () => {
    expect(unknownTopLevelWarnings("null")).toEqual([]);
    expect(unknownTopLevelWarnings("42")).toEqual([]);
    expect(unknownTopLevelWarnings("just a plain string")).toEqual([]);
  });

  it("returns no warnings for content over the manifest byte cap, without reparsing keys", () => {
    expect(unknownTopLevelWarnings("a".repeat(MAX_FOCUS_MANIFEST_BYTES + 1))).toEqual([]);
    expect(unknownTopLevelWarnings("é".repeat(Math.floor(MAX_FOCUS_MANIFEST_BYTES / 2) + 1))).toEqual([]);
  });

  it("does not reparse padded oversize content after trimming (regression)", () => {
    const result = unknownTopLevelWarnings(`${" ".repeat(MAX_FOCUS_MANIFEST_BYTES + 1)}unknownSecretKey: super-secret-value\n`);
    expect(result).toEqual([]);
  });
});

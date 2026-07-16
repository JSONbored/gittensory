import { parse as parseYaml } from "yaml";
import {
  MAX_FOCUS_MANIFEST_BYTES,
  contentLaneConfigToJson,
  featuresConfigToJson,
  gateConfigToJson,
  parseFocusManifestContent,
  repoDocGenerationConfigToJson,
  reviewConfigToJson,
  reviewRecapConfigToJson,
  maintainerRecapConfigToJson,
  settingsOverrideToJson,
  type FocusManifest,
  type FocusManifestSource,
} from "./focus-manifest.js";

// The recognized top-level `.loopover.yml` fields. The single source of truth for both the unknown-field
// warning below and the self-host config linter's recognized-field report (src/selfhost/config-lint.ts) —
// keeping one list stops the two surfaces drifting when a new field lands (the class of miss #3002/#5281 fixed).
export const TOP_LEVEL_FIELDS = [
  "source",
  "wantedPaths",
  "preferredLabels",
  "linkedIssuePolicy",
  "testExpectations",
  "issueDiscoveryPolicy",
  "maintainerNotes",
  "publicNotes",
  "gate",
  "settings",
  "review",
  "features",
  "experimental",
  "contentLane",
  "repoDocGeneration",
  "reviewRecap",
  "maintainerRecap",
] as const;

const TOP_LEVEL_FIELD_SET = new Set<string>(TOP_LEVEL_FIELDS);

// Fields retired from TOP_LEVEL_FIELDS that still warrant a migration-specific warning (rather than the
// generic "unknown field" message) pointing operators at their replacement mechanism.
const RETIRED_FIELD_MIGRATION_WARNINGS: Record<string, string> = {
  blockedPaths: "blockedPaths is retired; use settings.hardGuardrailGlobs for path holds.",
};

export function unknownTopLevelWarnings(text: string | null | undefined): string[] {
  const raw = text ?? "";
  const trimmed = raw.trim();
  if (!trimmed || isOversize(raw)) return [];
  const parsed = parseTopLevelObject(trimmed);
  if (parsed === null) return [];
  const keys = Object.keys(parsed).filter((key) => !TOP_LEVEL_FIELD_SET.has(key));
  // `hasOwnProperty.call`, NOT `key in`: a manifest field named like an Object.prototype member
  // (`constructor`, `toString`, `hasOwnProperty`, ...) would otherwise test true for the inherited
  // property and resolve to the prototype's function instead of a real retired-field warning string,
  // corrupting the string[] result and suppressing the genuine unknown-field warning.
  const isRetired = (key: string): boolean => Object.prototype.hasOwnProperty.call(RETIRED_FIELD_MIGRATION_WARNINGS, key);
  const retiredWarnings = keys.filter(isRetired).map((key) => RETIRED_FIELD_MIGRATION_WARNINGS[key]!);
  const unknown = keys.filter((key) => !isRetired(key)).map(formatFieldName);
  return [
    ...retiredWarnings,
    ...(unknown.length > 0 ? [`Manifest contains unknown top-level field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`] : []),
  ];
}

function parseTopLevelObject(text: string): Record<string, unknown> | null {
  const looksLikeJson = text.startsWith("{") || text.startsWith("[");
  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(text);
      return topLevelObjectOrNull(parsed);
    } catch {
      // YAML flow mappings can start with "{" or "[" while still being valid manifest syntax.
    }
  }
  try {
    return topLevelObjectOrNull(parseYaml(text));
  } catch {
    return null;
  }
}

export function topLevelObjectOrNull(parsed: unknown): Record<string, unknown> | null {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export function isOversize(text: string): boolean {
  return text.length > MAX_FOCUS_MANIFEST_BYTES || new TextEncoder().encode(text).byteLength > MAX_FOCUS_MANIFEST_BYTES;
}

function formatFieldName(name: string): string {
  const trimmed = name.replace(/[^\w.-]/g, "_").slice(0, 80);
  return trimmed || "<blank>";
}

export type FocusManifestValidationStatus = "ok" | "warn" | "error";

export type FocusManifestValidationResult = {
  present: boolean;
  warnings: string[];
  normalized: Record<string, unknown>;
  status: FocusManifestValidationStatus;
};

const PARSE_FAILURE_PATTERN = /not valid (JSON|YAML)|must be a mapping|exceeded \d+ bytes/i;

export function buildFocusManifestValidation(input: {
  content: string;
  source?: FocusManifestSource | undefined;
}): FocusManifestValidationResult {
  const manifest = parseFocusManifestContent(input.content, input.source ?? "repo_file");
  // Warn on unrecognized top-level fields (e.g. a typo'd `gates:` instead of `gate:`), matching the
  // selfhost config-lint validator — parseFocusManifestContent reads only known fields, so a mistyped
  // block is otherwise silently dropped with no warning (#5929).
  const warnings = [...manifest.warnings, ...unknownTopLevelWarnings(input.content)];
  const normalized = focusManifestToNormalizedJson(manifest);
  return {
    present: manifest.present,
    warnings,
    normalized,
    status: resolveValidationStatus(manifest, warnings),
  };
}

function resolveValidationStatus(manifest: FocusManifest, warnings: string[]): FocusManifestValidationStatus {
  if (warnings.some((warning) => PARSE_FAILURE_PATTERN.test(warning))) return "error";
  if (!manifest.present || warnings.length > 0) return "warn";
  return "ok";
}

function focusManifestToNormalizedJson(manifest: FocusManifest): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    present: manifest.present,
    source: manifest.source,
  };
  if (manifest.wantedPaths.length > 0) normalized.wantedPaths = manifest.wantedPaths;
  if (manifest.preferredLabels.length > 0) normalized.preferredLabels = manifest.preferredLabels;
  if (manifest.linkedIssuePolicy !== "optional") normalized.linkedIssuePolicy = manifest.linkedIssuePolicy;
  if (manifest.testExpectations.length > 0) normalized.testExpectations = manifest.testExpectations;
  if (manifest.issueDiscoveryPolicy !== "neutral") normalized.issueDiscoveryPolicy = manifest.issueDiscoveryPolicy;
  if (manifest.publicNotes.length > 0) normalized.publicNotes = manifest.publicNotes;

  const gate = gateConfigToJson(manifest.gate);
  if (gate !== null) normalized.gate = gate;
  const settings = settingsOverrideToJson(manifest.settings);
  if (settings !== null) normalized.settings = settings;
  const review = reviewConfigToJson(manifest.review);
  if (review !== null) normalized.review = review;
  const features = featuresConfigToJson(manifest.features);
  if (features !== null) normalized.features = features;
  const contentLane = contentLaneConfigToJson(manifest.contentLane);
  if (contentLane !== null) normalized.contentLane = contentLane;
  const repoDocGeneration = repoDocGenerationConfigToJson(manifest.repoDocGeneration);
  if (repoDocGeneration !== null) normalized.repoDocGeneration = repoDocGeneration;
  const reviewRecap = reviewRecapConfigToJson(manifest.reviewRecap);
  if (reviewRecap !== null) normalized.reviewRecap = reviewRecap;
  const maintainerRecap = maintainerRecapConfigToJson(manifest.maintainerRecap);
  if (maintainerRecap !== null) normalized.maintainerRecap = maintainerRecap;

  return normalized;
}

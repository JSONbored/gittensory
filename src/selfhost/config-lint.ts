import { parse as parseYaml } from "yaml";
import { MAX_FOCUS_MANIFEST_BYTES, TOP_LEVEL_FIELDS, parseFocusManifestContent, unknownTopLevelWarnings } from "../signals/focus-manifest";

const NO_RECOGNIZED_FOCUS_FIELDS_WARNING =
  "Manifest contained no recognized focus fields; falling back to deterministic signals.";

export type SelfHostConfigLintResult = {
  ok: boolean;
  warnings: string[];
  recognizedFields: string[];
  summary: string;
};

export function lintManifestText(text: string | null | undefined): SelfHostConfigLintResult {
  const manifest = parseFocusManifestContent(text, "repo_file");
  const recognizedFields = recognizedFieldsFor(text);
  const warnings = [
    ...manifest.warnings
      .map(redactManifestWarning)
      .filter((warning) => recognizedFields.length === 0 || warning !== NO_RECOGNIZED_FOCUS_FIELDS_WARNING),
    ...unknownTopLevelWarnings(text),
  ];
  if (warnings.length === 0 && recognizedFields.length === 0) {
    warnings.push("Manifest did not define any recognized focus fields.");
  }
  const ok = warnings.length === 0 && recognizedFields.length > 0;
  return {
    ok,
    warnings,
    recognizedFields,
    summary: ok
      ? `Manifest parsed ${recognizedFields.length} recognized field${recognizedFields.length === 1 ? "" : "s"}.`
      : `Manifest has ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
  };
}

function recognizedFieldsFor(text: string | null | undefined): string[] {
  const parsed = parseCanonicalTopLevelObject(text);
  if (parsed === null) return [];
  return TOP_LEVEL_FIELDS.filter(
    (field) => field !== "source" && Object.prototype.hasOwnProperty.call(parsed, field),
  );
}

function parseCanonicalTopLevelObject(text: string | null | undefined): Record<string, unknown> | null {
  const raw = text ?? "";
  const trimmed = raw.trim();
  if (!trimmed || isOversize(raw)) return null;
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  try {
    return topLevelObjectOrNull(looksLikeJson ? JSON.parse(trimmed) : parseYaml(trimmed));
  } catch {
    return null;
  }
}

function topLevelObjectOrNull(parsed: unknown): Record<string, unknown> | null {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function isOversize(text: string): boolean {
  return text.length > MAX_FOCUS_MANIFEST_BYTES || new TextEncoder().encode(text).byteLength > MAX_FOCUS_MANIFEST_BYTES;
}

function redactManifestWarning(warning: string): string {
  return warning
    .replace(/; ignoring "[^"]*"\./g, "; ignoring the supplied value.")
    .replace(/; ignoring "[^"]*"/g, "; ignoring the supplied value")
    .replace(/falling back to "[^"]*"/g, "falling back to the default");
}

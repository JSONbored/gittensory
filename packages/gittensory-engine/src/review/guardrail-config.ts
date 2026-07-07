import type { RepositorySettings } from "../types/predicted-gate-types.js";

/**
 * Resolve hard-guardrail path globs from the already-effective repo settings. Path holds are config-as-code only:
 * omitted/null settings mean no path guardrails, and arrays replace lower layers wholesale.
 */
export function resolveHardGuardrailGlobs(
  settings: Pick<RepositorySettings, "hardGuardrailGlobs"> | null | undefined,
): string[] {
  const configured = settings?.hardGuardrailGlobs;
  return Array.isArray(configured) ? [...configured] : [];
}

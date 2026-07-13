// gittensory -> loopover rebrand, self-host env var prefix rename (#4774): every operator-facing env var
// historically prefixed `GITTENSORY_` gets a `LOOPOVER_` companion name. This is a DUAL-READ addition,
// never a cutover -- an existing self-hoster's `.env` that sets only the legacy `GITTENSORY_` name must
// keep working completely unchanged.
//
// Precedence: the new `LOOPOVER_<suffix>` name wins when BOTH are set. This mirrors the repo's existing
// "explicit override first" precedent for a materially identical two-source resolution --
// `resolveSentryRelease` (src/selfhost/sentry.ts): `nonBlank(env.SENTRY_RELEASE) ?? nonBlank(env.GITTENSORY_VERSION)`,
// where the more specific/recently-set override always wins over the broader/older fallback. Applied
// here: an operator who has started migrating to LOOPOVER_ sees their new value take effect immediately,
// while an untouched .env stays byte-identical to today on the legacy GITTENSORY_ name.
//
// Lives outside `src/selfhost/**` (unlike its siblings `nonBlank`/`envString`, which are duplicated
// per-file there) because two of the seven affected vars (GITTENSORY_API_TOKEN, GITTENSORY_MCP_TOKEN) are
// actually consumed by core auth code (src/auth/security.ts) and the public API (src/api/routes.ts), not
// just src/selfhost/**.

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Read `LOOPOVER_<suffix>`, falling back to the legacy `GITTENSORY_<suffix>` when the new name is unset
 *  or blank (see precedence note above). `env` is any plain string-keyed record: `process.env`, or a
 *  Worker `Env` widened at the call site (`env as unknown as Record<string, string | undefined>`) since
 *  `Env` itself carries non-string bindings that don't satisfy a `string | undefined` index signature. */
export function dualPrefixEnvString(
  env: Record<string, string | undefined>,
  suffix: string,
): string | undefined {
  return nonBlank(env[`LOOPOVER_${suffix}`]) ?? nonBlank(env[`GITTENSORY_${suffix}`]);
}

/** Boolean-flag sibling of {@link dualPrefixEnvString}, reusing the codebase-wide loose truthy-string
 *  convention (`/^(1|true|yes|on)$/i`, same as `isPagerDutyEnabled`/`isOpsEnabled`/`isSafetyEnabled`).
 *  Use for a flag that was already loose-truthy under its `GITTENSORY_` name, e.g.
 *  `GITTENSORY_ENABLE_PAGERDUTY` -> `LOOPOVER_ENABLE_PAGERDUTY`. */
export function dualPrefixEnvFlag(env: Record<string, string | undefined>, suffix: string): boolean {
  return /^(1|true|yes|on)$/i.test(dualPrefixEnvString(env, suffix) ?? "");
}

/** Strict `"1"`-only sibling of {@link dualPrefixEnvString}, for a flag that intentionally does NOT use
 *  the loose truthy convention above -- e.g. `GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER` -> a deliberately
 *  narrow "unsafe opt-in" flag whose accepted values must not silently broaden while renaming it. */
export function dualPrefixEnvStrictFlag(env: Record<string, string | undefined>, suffix: string): boolean {
  return dualPrefixEnvString(env, suffix) === "1";
}

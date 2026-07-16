export type PlannerMode = "inherit" | "off" | "enabled";

/** Per-repo override resolved against the global default. Mirrors `resolveDuplicateWinnerEnabled`'s
 *  inherit/off/enabled shape (settings/duplicate-winner-mode.ts) -- symmetric: "off" and "enabled" both fully
 *  override the global default in either direction, so a repo that wants `@loopover plan` isn't blocked by a
 *  globally-off `LOOPOVER_REVIEW_PLANNER` default, and a repo that wants to opt OUT keeps the command disabled
 *  even when the fleet default is on. The global-default read itself stays `isPlannerEnabled` in
 *  `review/planner.ts` (predates this file, already the correct env-var-default shape, and every other
 *  `isPlannerEnabled` call site keeps importing it from there) -- this file adds only the missing per-repo
 *  resolver half of the settings/*-mode.ts pair, matching duplicate-winner-mode.ts/open-pr-file-collision-mode.ts's
 *  file-organization convention. */
export function resolvePlannerEnabled(globalDefault: boolean, mode: PlannerMode | null | undefined): boolean {
  if (mode === "off") return false;
  if (mode === "enabled") return true;
  return globalDefault;
}

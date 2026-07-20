#!/usr/bin/env tsx
// Read-only audit (#7596): how many currently-configured repos have NO effective `qualityGateMinScore` (readiness
// threshold) set, and — for that threshold-less population specifically — what per-action-class autonomy levels are
// actually in effect. Feeds the maintainer-only cold-start-default design issue (JSONbored/loopover#7595) with real
// data instead of a guess, per that issue's request that the decision be informed by "how common 'no threshold set'
// actually is today across current installs".
//
//   tsx scripts/audit-quality-gate-min-score.ts [--remote] [--db loopover] [--json]
//
// --remote reads the deployed D1 (default is the local miniflare DB). SELECT-only: this never writes to D1 and never
// changes any repo's settings or behavior. The markdown report is printed to stdout so it can be pasted verbatim as
// the findings comment on the design issue; progress/diagnostics go to stderr.
//
// Population = the rows of `repository_settings` (exactly "the current repository-settings population" the issue
// scopes to -- `getRepositorySettings` / `src/settings/repository-settings.ts` reads this table). The effective
// readiness threshold itself is config-as-code now: no `repository_settings` column backs `qualityGateMinScore`
// anymore (see src/db/repositories.ts -- it is unconditionally `null` there), so the value is resolved the same way
// `resolveRepositorySettings` resolves it -- from the repo's latest persisted `repo-focus-manifest` snapshot, where a
// typed `gate.readiness.minScore` wins over a generic `settings.qualityGateMinScore` (applyGateConfigOverrides,
// src/signals/focus-manifest.ts). The promoted self-tune override is deliberately ignored: it can only RAISE an
// existing threshold and never CREATE one (applySelfTuneOverrideToSettings), so it cannot change the unset count this
// audit measures.
import { spawnSync } from "node:child_process";
import { AGENT_ACTION_CLASSES, AUTONOMY_LEVELS, normalizeAutonomyPolicy, resolveAutonomy } from "../src/settings/autonomy";
import type { AgentActionClass, AutonomyLevel, AutonomyPolicy } from "../src/types";

/** The `repo-focus-manifest` signal `resolveRepositorySettings` overlays; NOT the contributor-preview public one. */
const REPO_FOCUS_MANIFEST_SIGNAL = "repo-focus-manifest";

interface SettingsRow {
  repo_full_name: string;
  autonomy_json: string;
}

interface ManifestRow {
  repo_full_name: string;
  payload_json: string;
}

/** What a repo's latest persisted manifest snapshot contributes to its effective settings, for this audit. */
export interface ManifestOverlay {
  /** Effective readiness threshold from the manifest: `gate.readiness.minScore` ?? `settings.qualityGateMinScore`. */
  minScore: number | null;
  /** `settings.autonomy` if the manifest set one (it wholesale-replaces the DB autonomy in the effective spread). */
  autonomy: AutonomyPolicy | undefined;
}

export type AutonomyLevelCounts = Record<AutonomyLevel, number>;

export interface QualityGateMinScoreAudit {
  /** Rows in `repository_settings` -- the audited population. */
  totalConfiguredRepos: number;
  reposWithThresholdSet: number;
  reposWithNoThreshold: number;
  /** `reposWithNoThreshold / totalConfiguredRepos`, or 0 when the population is empty. */
  fractionNoThreshold: number;
  /** For the no-threshold population only: how many of those repos resolve to each level, per action class. */
  noThresholdAutonomyByClass: Record<AgentActionClass, AutonomyLevelCounts>;
  /** Context: repos whose threshold is set purely via `.loopover.yml` with no `repository_settings` row, so they sit
   *  OUTSIDE the audited population -- surfaced so the cold-start view isn't blind to config-as-code-only thresholds. */
  manifestOnlyThresholdRepos: number;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extract what a persisted manifest snapshot payload contributes to a repo's effective settings. Mirrors the real
 * resolution: the typed `gate.readiness.minScore` alias wins over the generic `settings.qualityGateMinScore`, and a
 * present `settings.autonomy` wholesale-replaces the DB autonomy (both per src/signals/focus-manifest.ts). Any
 * malformed/absent field degrades to "unset", never throwing -- an audit must not crash on one bad snapshot row.
 */
export function parseManifestOverlay(payloadJson: string): ManifestOverlay {
  const payload = asRecord(safeJsonParse(payloadJson));
  const gate = payload ? asRecord(payload.gate) : null;
  const readiness = gate ? asRecord(gate.readiness) : null;
  const settings = payload ? asRecord(payload.settings) : null;
  const gateMinScore = readiness ? finiteNumberOrNull(readiness.minScore) : null;
  const settingsMinScore = settings ? finiteNumberOrNull(settings.qualityGateMinScore) : null;
  const minScore = gateMinScore ?? settingsMinScore;
  const autonomy = settings && settings.autonomy !== undefined ? normalizeAutonomyPolicy(settings.autonomy) : undefined;
  return { minScore, autonomy };
}

function emptyLevelCounts(): AutonomyLevelCounts {
  const counts = {} as AutonomyLevelCounts;
  for (const level of AUTONOMY_LEVELS) counts[level] = 0;
  return counts;
}

/**
 * PURE aggregation of the audit over already-SELECTed rows. Keeps the IO (wrangler/D1 reads below) out of the
 * counting logic so the report shape is unit-testable without a database.
 */
export function computeAudit(input: { settingsRows: SettingsRow[]; manifestRows: ManifestRow[] }): QualityGateMinScoreAudit {
  const overlayByRepo = new Map<string, ManifestOverlay>();
  for (const row of input.manifestRows) overlayByRepo.set(row.repo_full_name, parseManifestOverlay(row.payload_json));

  const noThresholdAutonomyByClass = {} as Record<AgentActionClass, AutonomyLevelCounts>;
  for (const actionClass of AGENT_ACTION_CLASSES) noThresholdAutonomyByClass[actionClass] = emptyLevelCounts();

  const configuredRepos = new Set<string>();
  let reposWithThresholdSet = 0;
  let reposWithNoThreshold = 0;
  for (const row of input.settingsRows) {
    configuredRepos.add(row.repo_full_name);
    const overlay = overlayByRepo.get(row.repo_full_name);
    if (overlay && overlay.minScore !== null) {
      reposWithThresholdSet += 1;
      continue;
    }
    reposWithNoThreshold += 1;
    // Effective autonomy: a manifest-set `settings.autonomy` replaces the DB row's; otherwise the DB row stands.
    const effectiveAutonomy = overlay?.autonomy ?? normalizeAutonomyPolicy(safeJsonParse(row.autonomy_json));
    for (const actionClass of AGENT_ACTION_CLASSES) {
      noThresholdAutonomyByClass[actionClass][resolveAutonomy(effectiveAutonomy, actionClass)] += 1;
    }
  }

  let manifestOnlyThresholdRepos = 0;
  for (const [repo, overlay] of overlayByRepo) {
    if (overlay.minScore !== null && !configuredRepos.has(repo)) manifestOnlyThresholdRepos += 1;
  }

  const totalConfiguredRepos = configuredRepos.size;
  return {
    totalConfiguredRepos,
    reposWithThresholdSet,
    reposWithNoThreshold,
    fractionNoThreshold: totalConfiguredRepos === 0 ? 0 : reposWithNoThreshold / totalConfiguredRepos,
    noThresholdAutonomyByClass,
    manifestOnlyThresholdRepos,
  };
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Render the audit as a markdown comment body, ready to paste onto the cold-start-default design issue. */
export function formatMarkdownReport(audit: QualityGateMinScoreAudit): string {
  const lines: string[] = [];
  lines.push("## `qualityGateMinScore`-unset audit (#7596)");
  lines.push("");
  lines.push(
    `Across the **${audit.totalConfiguredRepos}** repos with a \`repository_settings\` row, ` +
      `**${audit.reposWithNoThreshold}** (**${formatPercent(audit.fractionNoThreshold)}**) have no effective ` +
      `\`qualityGateMinScore\` set at all; **${audit.reposWithThresholdSet}** have one.`,
  );
  lines.push("");
  lines.push("Effective autonomy levels in force for the **no-threshold** population, per action class:");
  lines.push("");
  lines.push(`| Action class | ${AUTONOMY_LEVELS.join(" | ")} |`);
  lines.push(`| --- | ${AUTONOMY_LEVELS.map(() => "---:").join(" | ")} |`);
  for (const actionClass of AGENT_ACTION_CLASSES) {
    const counts = audit.noThresholdAutonomyByClass[actionClass];
    lines.push(`| \`${actionClass}\` | ${AUTONOMY_LEVELS.map((level) => counts[level]).join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    `_Read-only audit; no settings changed. Threshold resolved as \`resolveRepositorySettings\` does ` +
      `(manifest \`gate.readiness.minScore\` > \`settings.qualityGateMinScore\`, from each repo's latest ` +
      `\`${REPO_FOCUS_MANIFEST_SIGNAL}\` snapshot); the tightening-only self-tune override never creates a threshold, ` +
      `so it cannot affect the unset count. ${audit.manifestOnlyThresholdRepos} further repo(s) set a threshold via ` +
      `\`.loopover.yml\` with no \`repository_settings\` row and so fall outside this population._`,
  );
  return lines.join("\n");
}

/** Run a read-only SQL statement via wrangler and return its result rows. Throws on any failure so a partial read
 *  can never be mistaken for a complete audit. */
function d1Query<T>(db: string, remote: boolean, sql: string): T[] {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const results = asRecord(first)?.results;
  return Array.isArray(results) ? (results as T[]) : [];
}

interface CliArgs {
  db: string;
  remote: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { db: "loopover", remote: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote") args.remote = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--db") args.db = argv[++i] ?? args.db;
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const settingsRows = d1Query<SettingsRow>(args.db, args.remote, "SELECT repo_full_name, autonomy_json FROM repository_settings");
  // Latest snapshot per repo, matching listSignalSnapshots' own "latest" definition (highest generated_at, then
  // highest rowid) so the audit reads exactly the row the worker would resolve settings from.
  const manifestRows = d1Query<ManifestRow>(
    args.db,
    args.remote,
    "SELECT repo_full_name, payload_json FROM (" +
      "SELECT target_key AS repo_full_name, payload_json, " +
      "ROW_NUMBER() OVER (PARTITION BY target_key ORDER BY generated_at DESC, rowid DESC) AS rn " +
      `FROM signal_snapshots WHERE signal_type = '${REPO_FOCUS_MANIFEST_SIGNAL}') WHERE rn = 1`,
  );
  const audit = computeAudit({ settingsRows, manifestRows });
  process.stderr.write(
    `audited ${audit.totalConfiguredRepos} configured repos: ${audit.reposWithNoThreshold} unset (${formatPercent(audit.fractionNoThreshold)}), ` +
      `${audit.reposWithThresholdSet} set\n`,
  );
  process.stdout.write(`${args.json ? JSON.stringify(audit, null, 2) : formatMarkdownReport(audit)}\n`);
}

// Only run the IO path when executed directly, so the pure exports above stay importable by the unit test.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();

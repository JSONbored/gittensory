// Structural privacy-boundary guard (#fairness-analytics, #global-contributor-trust): the per-login gate-decision
// data (contributor_gate_history) and everything derived from it -- per-project OR the new cross-repo blended
// figure -- must NEVER be reachable from a public-facing surface. This mirrors worker-entry-boundary.test.ts's
// import-reachability technique (a runtime JSON-shape assertion can't catch "this module isn't wired in yet but
// COULD be imported tomorrow"; a static reachability scan catches that at the source-graph level instead).
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoot = join(root, "src");

// The two public-facing surfaces this data must never reach:
//   - public-stats.ts: builds GET /v1/public/stats's payload (Phase 1 aggregate fairness metrics).
//   - orb-collector.ts: exportOrbBatch, the anonymized cross-instance fleet-telemetry export.
const PUBLIC_ENTRY_POINTS = [join(srcRoot, "review/public-stats.ts"), join(srcRoot, "selfhost/orb-collector.ts")];

// The per-login contributor-identity family -- contributor-gate-eval.ts's own header (and
// contributor-trust-profile.ts's, which inherits it) documents this as internal/bearer-gated-only, NEVER
// rendered on any public surface. The blended (#global-contributor-trust) functions live in the same file as
// the per-project ones and inherit the identical restriction -- see contributor-gate-eval.ts's header comment.
const FORBIDDEN_MODULES = [
  join(srcRoot, "review/contributor-gate-eval.ts"),
  join(srcRoot, "review/contributor-trust-profile.ts"),
  join(srcRoot, "review/contributor-gate-history-backfill.ts"),
  join(srcRoot, "review/contributor-calibration.ts"),
];

function resolveLocalImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = dirname(fromFile);
  const candidates = [join(base, specifier), join(base, `${specifier}.ts`), join(base, `${specifier}.tsx`), join(base, specifier, "index.ts")];
  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function parseImportSpecifiers(filePath: string): string[] {
  const content = readFileSync(filePath, "utf8");
  const specifiers = new Set<string>();
  for (const match of content.matchAll(/(?:import|export)\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/g)) specifiers.add(match[1]!);
  for (const match of content.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1]!);
  return [...specifiers];
}

function collectReachableSources(entryFile: string): string[] {
  const queue = [entryFile];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of parseImportSpecifiers(file)) {
      const resolved = resolveLocalImport(file, specifier);
      if (resolved && resolved.startsWith(srcRoot) && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
}

function relativeToRoot(path: string): string {
  return path.replace(`${root}/`, "");
}

describe("contributor-identity privacy boundary (#fairness-analytics, #global-contributor-trust)", () => {
  for (const entry of PUBLIC_ENTRY_POINTS) {
    it(`${relativeToRoot(entry)} never reaches the per-login contributor-identity module family, including the cross-repo blended score`, () => {
      const reachable = new Set(collectReachableSources(entry));
      const leaked = FORBIDDEN_MODULES.filter((forbidden) => reachable.has(forbidden)).map(relativeToRoot);
      expect(leaked, `public-facing entry point must never import contributor-identity modules: ${leaked.join(", ")}`).toEqual([]);
    });
  }
});

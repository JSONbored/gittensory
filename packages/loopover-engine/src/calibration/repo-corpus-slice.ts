// Per-repo corpus slicing + density stats (#8215, epic #8211 track B) -- the pure building block per-repo
// autonomy needs before any per-repo evaluation can run. Every BacktestCase carries its repo inside
// `targetKey` (`owner/repo#N`), but the calibration primitives only ever evaluate globally; these two
// functions carve a corpus into per-repo slices and report which repos have enough labeled density to be
// evaluable at all.
//
// PURE, storage-agnostic, aggregate-only: no IO, no store reads, no registry access; every returned shape is
// repo names + counts + a boolean -- never a targetKey or metadata -- the same public-safe discipline the
// rest of the calibration module follows (#8083-#8087).

import type { BacktestCase } from "./backtest-corpus.js";
import { splitBacktestCorpus } from "./backtest-split.js";

/** Per-repo labeled-density summary: total cases in the repo's slice, their confirmed/reversed breakdown, and
 *  whether the slice clears the evaluation floors after the standard held-out split. Aggregate-only. */
export type RepoCorpusDensity = {
  cases: number;
  confirmed: number;
  reversed: number;
  eligible: boolean;
};

/** Parse the `owner/repo` prefix from a `BacktestCase.targetKey` shaped `owner/repo#N`. Returns null for a key
 *  with no `#`, or with an empty repo portion before the last `#` -- the caller drops those rather than
 *  guessing a repo (`lastIndexOf` so a stray `#` inside an issue fragment can't truncate the repo early). */
function repoFromTargetKey(targetKey: string): string | null {
  const hashIndex = targetKey.lastIndexOf("#");
  if (hashIndex <= 0) return null;
  return targetKey.slice(0, hashIndex);
}

/**
 * Slice a corpus into per-repo groups keyed by `owner/repo`, deterministically. A case whose `targetKey` has
 * no parseable repo (no `#`, or an empty prefix) is dropped, never guessed. Case order within each slice
 * preserves the input order; Map key order is first-seen-repo order -- both deterministic for a given input.
 */
export function sliceCorpusByRepo(cases: readonly BacktestCase[]): Map<string, BacktestCase[]> {
  const slices = new Map<string, BacktestCase[]>();
  for (const backtestCase of cases) {
    const repo = repoFromTargetKey(backtestCase.targetKey);
    if (repo === null) continue;
    const existing = slices.get(repo);
    if (existing) existing.push(backtestCase);
    else slices.set(repo, [backtestCase]);
  }
  return slices;
}

/**
 * Per-repo density report. For each repo slice: total `cases`, the `confirmed`/`reversed` label split, and
 * `eligible` -- true only when the repo's OWN slice, split by the same `splitBacktestCorpus` seed/fraction the
 * knob evaluators use, yields at least `minVisible` visible and `minHeldOut` held-out cases. A repo is
 * evaluable only if its own slice clears both floors, so a large global corpus can't lend density to a
 * sparse repo. Aggregate-only output (repo names + numbers). Deterministic for a given input + params.
 */
export function computeRepoCorpusDensity(
  cases: readonly BacktestCase[],
  minVisible: number,
  minHeldOut: number,
  heldOutFraction: number,
  splitSeed: string,
): Map<string, RepoCorpusDensity> {
  const density = new Map<string, RepoCorpusDensity>();
  for (const [repo, repoCases] of sliceCorpusByRepo(cases)) {
    let confirmed = 0;
    let reversed = 0;
    for (const backtestCase of repoCases) {
      if (backtestCase.label === "confirmed") confirmed += 1;
      else reversed += 1;
    }
    const { visible, heldOut } = splitBacktestCorpus(repoCases, heldOutFraction, splitSeed);
    density.set(repo, {
      cases: repoCases.length,
      confirmed,
      reversed,
      eligible: visible.length >= minVisible && heldOut.length >= minHeldOut,
    });
  }
  return density;
}

import assert from "node:assert/strict";
import { test } from "node:test";

import { computeRepoCorpusDensity, sliceCorpusByRepo, type BacktestCase } from "../dist/index.js";

function bcase(targetKey: string, label: BacktestCase["label"] = "confirmed"): BacktestCase {
  return {
    ruleId: "missing_linked_issue",
    targetKey,
    outcome: "block",
    label,
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
  };
}

test("barrel: the public entrypoint re-exports the repo-corpus-slice primitives (#8215)", () => {
  assert.equal(typeof sliceCorpusByRepo, "function");
  assert.equal(typeof computeRepoCorpusDensity, "function");
});

test("sliceCorpusByRepo: groups by owner/repo, preserving input order within each slice and first-seen key order", () => {
  const slices = sliceCorpusByRepo([
    bcase("acme/widgets#1"),
    bcase("acme/gadgets#5"),
    bcase("acme/widgets#2"),
    bcase("acme/gadgets#9"),
  ]);
  assert.deepEqual([...slices.keys()], ["acme/widgets", "acme/gadgets"]);
  assert.deepEqual(slices.get("acme/widgets")!.map((c) => c.targetKey), ["acme/widgets#1", "acme/widgets#2"]);
  assert.deepEqual(slices.get("acme/gadgets")!.map((c) => c.targetKey), ["acme/gadgets#5", "acme/gadgets#9"]);
});

test("sliceCorpusByRepo: drops targetKeys with no '#' or an empty repo prefix, never guessing", () => {
  const slices = sliceCorpusByRepo([bcase("acme/widgets#1"), bcase("no-hash"), bcase("#123")]);
  assert.deepEqual([...slices.keys()], ["acme/widgets"]);
  assert.equal(slices.get("acme/widgets")!.length, 1);
});

test("sliceCorpusByRepo: parses the repo from the LAST '#' so an issue-fragment hash can't truncate it early", () => {
  const slices = sliceCorpusByRepo([bcase("acme/widgets#12#note")]);
  assert.deepEqual([...slices.keys()], ["acme/widgets#12"]);
});

test("computeRepoCorpusDensity: reports per-repo case counts and the confirmed/reversed label split", () => {
  const density = computeRepoCorpusDensity(
    [bcase("acme/widgets#1", "confirmed"), bcase("acme/widgets#2", "reversed"), bcase("acme/widgets#3", "confirmed")],
    0,
    0,
    0,
    "seed",
  );
  assert.deepEqual(density.get("acme/widgets"), { cases: 3, confirmed: 2, reversed: 1, eligible: true });
});

test("computeRepoCorpusDensity: eligible=true when a repo's own slice clears both floors after the split", () => {
  // heldOutFraction 0 -> every case is visible, none held out; minHeldOut 0 keeps the held-out floor satisfied.
  const density = computeRepoCorpusDensity([bcase("acme/widgets#1"), bcase("acme/widgets#2")], 2, 0, 0, "seed");
  assert.equal(density.get("acme/widgets")!.eligible, true);
});

test("computeRepoCorpusDensity: eligible=false when the visible floor is not met (left side of the &&)", () => {
  const density = computeRepoCorpusDensity([bcase("acme/widgets#1"), bcase("acme/widgets#2")], 5, 0, 0, "seed");
  assert.equal(density.get("acme/widgets")!.eligible, false);
});

test("computeRepoCorpusDensity: eligible=false when the held-out floor is not met (right side of the &&)", () => {
  // fraction 0 -> heldOut is empty, so a minHeldOut of 1 fails even though the visible floor passes.
  const density = computeRepoCorpusDensity([bcase("acme/widgets#1"), bcase("acme/widgets#2")], 1, 1, 0, "seed");
  assert.equal(density.get("acme/widgets")!.eligible, false);
});

test("computeRepoCorpusDensity: a large global corpus cannot lend density to a sparse repo (own-slice floors)", () => {
  const cases = [
    ...Array.from({ length: 8 }, (_unused, i) => bcase(`acme/big#${i}`)),
    bcase("acme/small#1"),
  ];
  const density = computeRepoCorpusDensity(cases, 3, 0, 0, "seed");
  assert.equal(density.get("acme/big")!.eligible, true);
  assert.equal(density.get("acme/small")!.eligible, false);
});

test("computeRepoCorpusDensity: deterministic — same corpus + params yields an equal report", () => {
  const cases = [bcase("acme/widgets#1", "confirmed"), bcase("acme/gadgets#2", "reversed")];
  const a = computeRepoCorpusDensity(cases, 1, 0, 0.5, "seed");
  const b = computeRepoCorpusDensity(cases, 1, 0, 0.5, "seed");
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test("computeRepoCorpusDensity: an empty corpus yields an empty density map", () => {
  assert.equal(computeRepoCorpusDensity([], 1, 1, 0.5, "seed").size, 0);
});

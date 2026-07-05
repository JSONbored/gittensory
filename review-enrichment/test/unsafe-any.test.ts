// Units for the unsafe-`any` counter (#2017). Own file (not enrichment.test.ts) so concurrent analyzer PRs don't
// collide. Pure local analyzer — no network. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripStringsAndComments,
  findUnsafeAnyOnLine,
  scanPatchForUnsafeAny,
  scanUnsafeAny,
} from "../dist/analyzers/unsafe-any.js";
import { renderBrief } from "../dist/render.js";

const req = (files) => ({ repoFullName: "octo/repo", prNumber: 1, files });

test("findUnsafeAnyOnLine: classifies annotation, cast, and assertion (and multiples on one line)", () => {
  assert.deepEqual(findUnsafeAnyOnLine("function f(x: any) {}"), ["annotation"]);
  assert.deepEqual(findUnsafeAnyOnLine("const y = z as any;"), ["cast"]);
  assert.deepEqual(findUnsafeAnyOnLine("const w = <any>v;"), ["assertion"]);
  // both an annotation and a cast on the same line
  assert.deepEqual(findUnsafeAnyOnLine("const a: any = b as any;").sort(), ["annotation", "cast"]);
  assert.deepEqual(findUnsafeAnyOnLine("const clean = 1;"), []);
});

test("stripStringsAndComments: an `any` inside a string or comment is not counted", () => {
  assert.deepEqual(findUnsafeAnyOnLine('const s = "not: any here";'), []); // inside a string literal
  assert.deepEqual(findUnsafeAnyOnLine("const n = 1; // x: any in a comment"), []); // trailing line comment
  assert.deepEqual(findUnsafeAnyOnLine("// : any comment-only line"), []); // comment-only line
  assert.deepEqual(findUnsafeAnyOnLine(" * @param x: any (jsdoc body)"), []); // block-comment body line
  // a REAL annotation still counts even with a decoy `any` inside a string on the same line
  assert.deepEqual(findUnsafeAnyOnLine('const obj: any = "x: any";'), ["annotation"]);
  assert.equal(stripStringsAndComments('x = "a: any"').includes("any"), false);
});

test("scanPatchForUnsafeAny: reports each added `any` with its new-file line number", () => {
  const patch = [
    "@@ -0,0 +1,4 @@",
    "+function f(x: any) {}",
    "+const y = z as any;",
    "+const w = <any>v;",
    '+const s = "not: any here";',
  ].join("\n");
  assert.deepEqual(scanPatchForUnsafeAny("src/a.ts", patch), [
    { file: "src/a.ts", line: 1, kind: "annotation" },
    { file: "src/a.ts", line: 2, kind: "cast" },
    { file: "src/a.ts", line: 3, kind: "assertion" },
  ]);
});

test("scanUnsafeAny: scans .ts/.tsx only — non-TS and .d.ts files are skipped", async () => {
  const patch = "@@ -0,0 +1,1 @@\n+const x: any = 1;";
  const findings = await scanUnsafeAny(
    req([
      { path: "src/a.ts", status: "modified", patch }, // scanned
      { path: "src/b.tsx", status: "modified", patch }, // scanned
      { path: "src/c.js", status: "modified", patch }, // skipped (not TS)
      { path: "README.md", status: "modified", patch }, // skipped
      { path: "src/types.d.ts", status: "modified", patch }, // skipped (ambient)
    ]),
  );
  assert.deepEqual(findings, [
    { file: "src/a.ts", line: 1, kind: "annotation" },
    { file: "src/b.tsx", line: 1, kind: "annotation" },
  ]);
  const brief = renderBrief({ unsafeAny: findings }).promptSection;
  assert.match(brief, /New unsafe .*any.* usages/i);
  assert.match(brief, /src\/a\.ts:1/);
});

test("scanUnsafeAny: caps the number of findings", async () => {
  const lines = ["@@ -0,0 +1,60 @@"];
  for (let i = 0; i < 60; i++) lines.push("+const x: any = 1;");
  const findings = await scanUnsafeAny(req([{ path: "src/a.ts", status: "modified", patch: lines.join("\n") }]));
  assert.equal(findings.length, 50); // MAX_FINDINGS
});

test("scanUnsafeAny: a file with no patch or no `any` yields nothing", async () => {
  assert.deepEqual(await scanUnsafeAny(req([{ path: "src/a.ts", status: "added" }])), []); // no patch
  assert.deepEqual(
    await scanUnsafeAny(req([{ path: "src/a.ts", status: "modified", patch: "@@ -0,0 +1,1 @@\n+const x = 1;" }])),
    [],
  );
});

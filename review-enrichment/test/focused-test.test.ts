// Units for the focused-test analyzer (part of #1499). Own file (not enrichment.test.ts) so concurrent analyzer
// PRs don't collide. No network — pure, stateless per-line detection. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectFocusedTest,
  scanFocusedTest,
  scanPatchForFocusedTest,
} from "../dist/analyzers/focused-test.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectFocusedTest: recognizes .only on every test-block function", () => {
  assert.equal(detectFocusedTest("describe.only('a', () => {"), "only");
  assert.equal(detectFocusedTest("  it.only('does x', () => {"), "only");
  assert.equal(detectFocusedTest("test.only('y', () => {"), "only");
  assert.equal(detectFocusedTest("context.only('z', () => {"), "only");
  assert.equal(detectFocusedTest("suite.only('s', () => {"), "only");
  assert.equal(detectFocusedTest("specify.only('w', () => {"), "only");
  // whitespace tolerance around the dot and call paren
  assert.equal(detectFocusedTest("it . only ( 'spaced', () => {"), "only");
});

test("detectFocusedTest: ordinary tests and non-test .only calls are not flagged", () => {
  assert.equal(detectFocusedTest("it('does x', () => {"), null);
  assert.equal(detectFocusedTest("describe('suite', () => {"), null);
  // `.only(` on something that is not a test-block function
  assert.equal(detectFocusedTest("stream.only(handler)"), null);
  // a test-fn name embedded in a longer identifier must not match
  assert.equal(detectFocusedTest("submit.only(form)"), null);
  // `.only` with no call paren is not a focused-test call
  assert.equal(detectFocusedTest("const flag = it.only"), null);
});

test("detectFocusedTest: a .only inside a string literal is not flagged", () => {
  assert.equal(detectFocusedTest('const s = "it.only(\'x\')";'), null);
});

test("scanPatchForFocusedTest: only scans test files", () => {
  const patch = patchOf(["it.only('x', () => {});"]);
  assert.deepEqual(scanPatchForFocusedTest("src/widget.test.ts", patch), [
    { file: "src/widget.test.ts", line: 1, kind: "only" },
  ]);
  // a .only in a non-test source file is not a focused test → skipped
  assert.deepEqual(scanPatchForFocusedTest("src/widget.ts", patch), []);
});

test("scanPatchForFocusedTest: cites the correct new-file line across context and removed lines", () => {
  const patch = [
    "@@ -1,2 +1,4 @@",
    " import { test } from 'node:test';", // context → line 1
    "+// setup", // added → line 2
    "-const old = 1;", // removed → no new line
    "+it.only('focused', () => {});", // added → line 3
    "+test('other', () => {});", // added → line 4
  ].join("\n");
  assert.deepEqual(scanPatchForFocusedTest("test/foo.spec.ts", patch), [
    { file: "test/foo.spec.ts", line: 3, kind: "only" },
  ]);
});

test("scanPatchForFocusedTest: respects the maxFindings cap", () => {
  const patch = patchOf([
    "it.only('a', () => {});",
    "test.only('b', () => {});",
    "describe.only('c', () => {});",
  ]);
  assert.equal(scanPatchForFocusedTest("a.test.ts", patch, { maxFindings: 2 }).length, 2);
  assert.deepEqual(scanPatchForFocusedTest("a.test.ts", patch, { maxFindings: 0 }), []);
});

test("scanFocusedTest: scans every changed test file, skipping non-test files and files without a patch", async () => {
  const findings = await scanFocusedTest({
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "a.test.ts", patch: patchOf(["it.only('x', () => {});"]) },
      { path: "b.ts", patch: patchOf(["it.only('y', () => {});"]) }, // non-test → skipped
      { path: "c.test.ts", patch: null }, // no patch → skipped
      { path: "d.spec.ts", patch: patchOf(["describe.only('z', () => {});"]) },
    ],
  });
  assert.deepEqual(findings, [
    { file: "a.test.ts", line: 1, kind: "only" },
    { file: "d.spec.ts", line: 1, kind: "only" },
  ]);
});

test("focusedTest renders a section only when there are findings", () => {
  const { promptSection } = renderBrief({
    focusedTest: [{ file: "a.test.ts", line: 3, kind: "only" }],
  });
  assert.match(promptSection, /Focused tests/);
  assert.match(promptSection, /a\.test\.ts:3/);

  const { promptSection: empty } = renderBrief({ focusedTest: [] });
  assert.doesNotMatch(empty, /Focused tests/);
});

// Units for the accessibility-regression analyzer (#2026). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectA11yIssues,
  scanA11y,
  scanPatchForA11y,
} from "../dist/analyzers/a11y-regression.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectA11yIssues: flags <img> without alt", () => {
  assert.deepEqual(detectA11yIssues("img", ' src="x.png"'), ["img-alt"]);
});

test("detectA11yIssues: does not flag <img> with alt", () => {
  assert.deepEqual(detectA11yIssues("img", ' src="x.png" alt="a cat"'), []);
});

test("detectA11yIssues: flags onClick on a non-interactive element with no keyboard handler or role", () => {
  assert.deepEqual(detectA11yIssues("div", ' onClick={handleClick}'), [
    "click-events-have-key-events",
  ]);
  assert.deepEqual(detectA11yIssues("div", ' onclick="handleClick()"'), [
    "click-events-have-key-events",
  ]);
});

test("detectA11yIssues: does not flag onClick when a keyboard handler is present", () => {
  assert.deepEqual(
    detectA11yIssues("div", ' onClick={handleClick} onKeyDown={handleKey}'),
    [],
  );
  assert.deepEqual(detectA11yIssues("div", ' onclick="x()" onkeydown="y()"'), []);
});

test("detectA11yIssues: onKeyPress alone does NOT satisfy the keyboard-accessible check", () => {
  assert.deepEqual(
    detectA11yIssues("div", ' onClick={handleClick} onKeyPress={handleKey}'),
    ["click-events-have-key-events"],
  );
});

test("detectA11yIssues: does not flag onClick when a role is present", () => {
  assert.deepEqual(detectA11yIssues("span", ' onClick={handleClick} role="button"'), []);
});

test("detectA11yIssues: does not flag onClick on an inherently interactive element", () => {
  assert.deepEqual(detectA11yIssues("button", ' onClick={handleClick}'), []);
});

test("detectA11yIssues: flags a form control with no label association", () => {
  assert.deepEqual(detectA11yIssues("input", ' type="text"'), ["label-control"]);
});

test("detectA11yIssues: does not flag a form control with an id or aria-label", () => {
  assert.deepEqual(detectA11yIssues("input", ' type="text" id="name"'), []);
  assert.deepEqual(detectA11yIssues("textarea", ' aria-label="Comments"'), []);
});

test("detectA11yIssues: does not flag labelless input types", () => {
  assert.deepEqual(detectA11yIssues("input", ' type="hidden" value="1"'), []);
  assert.deepEqual(detectA11yIssues("input", ' type="submit" value="Go"'), []);
});

test("detectA11yIssues: flags a positive tabindex", () => {
  assert.deepEqual(detectA11yIssues("div", ' tabIndex={2}'), ["positive-tabindex"]);
  assert.deepEqual(detectA11yIssues("div", ' tabindex="1"'), ["positive-tabindex"]);
});

test("detectA11yIssues: does not flag tabindex 0 or -1", () => {
  assert.deepEqual(detectA11yIssues("div", ' tabIndex={0}'), []);
  assert.deepEqual(detectA11yIssues("div", ' tabindex="-1"'), []);
});

test("scanPatchForA11y: reports file/line for a flagged tag", () => {
  assert.deepEqual(scanPatchForA11y("src/Widget.tsx", patchOf(['<img src="x.png" />'])), [
    { file: "src/Widget.tsx", line: 1, rule: "img-alt" },
  ]);
});

test("scanPatchForA11y: a compliant element yields no findings", () => {
  assert.deepEqual(
    scanPatchForA11y("src/Widget.tsx", patchOf(['<img src="x.png" alt="a cat" />'])),
    [],
  );
});

test("scanPatchForA11y: skips non-markup and test paths", () => {
  const patch = patchOf(['<img src="x.png" />']);
  assert.deepEqual(scanPatchForA11y("src/widget.ts", patch), []);
  assert.deepEqual(scanPatchForA11y("src/Widget.test.tsx", patch), []);
});

test("scanPatchForA11y: skips commented-out markup", () => {
  assert.deepEqual(
    scanPatchForA11y("src/Widget.jsx", patchOf(['{/* <img src="x.png" /> */}'])),
    [],
  );
});

test("scanPatchForA11y: respects the maxFindings cap", () => {
  const lines = Array.from({ length: 5 }, (_, i) => `<img src="${i}.png" />`);
  assert.equal(scanPatchForA11y("src/Widget.tsx", patchOf(lines), { maxFindings: 2 }).length, 2);
});

test("scanPatchForA11y: line numbers advance correctly across a hunk", () => {
  const patch = ["@@ -1,2 +1,3 @@", " <div>", '+  <img src="x.png" />', " </div>"].join("\n");
  assert.deepEqual(scanPatchForA11y("src/Widget.html", patch), [
    { file: "src/Widget.html", line: 2, rule: "img-alt" },
  ]);
});

test("scanA11y: aggregates across files and renders a public-safe brief", async () => {
  const findings = await scanA11y({
    files: [{ path: "src/Widget.tsx", patch: patchOf(['<img src="x.png" />']) }],
  });
  assert.equal(findings[0]?.rule, "img-alt");
  const { promptSection } = renderBrief({ a11y: findings });
  assert.match(promptSection, /Accessibility regressions/);
  assert.match(promptSection, /src\/Widget\.tsx:1/);
});

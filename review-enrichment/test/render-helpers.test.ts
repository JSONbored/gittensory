// Units for the shared analyzer-render helpers (render-helpers.ts). Own file (not render-contract.test.ts or
// terminology.test.ts) so it can cover the helpers directly as well as the boundary they sit behind. Regression
// coverage for GITTENSORY-15: "TypeError: value.replace is not a function" thrown from safeCodeSpan when a
// terminology finding's `term`/`suggestion` reached render as a non-string. safeCodeSpan/promptText are typed
// `(value: string): string`, but they receive values from less-trusted analyzer/descriptor output (routed through
// `as never` casts in render.ts/registry.ts), the same boundary bytesLabel already defends with its
// `value: number | null` guard -- so both now defensively coerce instead of trusting the type signature.
import { test } from "node:test";
import assert from "node:assert/strict";

import { safeCodeSpan, promptText } from "../dist/render-helpers.js";
import { renderBrief } from "../dist/render.js";

test("safeCodeSpan: wraps a normal string in backticks unchanged", () => {
  assert.equal(safeCodeSpan("src/net.ts:12"), "`src/net.ts:12`");
});

test("safeCodeSpan: escapes backticks and control characters in a real string", () => {
  assert.equal(safeCodeSpan("a`b\nc"), "`aˋb␤c`");
});

test("safeCodeSpan: coerces a non-string value instead of throwing (GITTENSORY-15 regression)", () => {
  assert.equal(safeCodeSpan(undefined), "``");
  assert.equal(safeCodeSpan(null), "``");
  assert.equal(safeCodeSpan(42), "`42`");
  assert.equal(safeCodeSpan(["master", "slave"]), "`master,slave`");
  assert.equal(safeCodeSpan({ toString: () => "obj" }), "`obj`");
});

test("promptText: escapes markdown-sensitive characters in a real string", () => {
  assert.equal(promptText("a*b_c"), "a\\*b\\_c");
});

test("promptText: coerces a non-string value instead of throwing (GITTENSORY-15 regression)", () => {
  assert.equal(promptText(undefined), "");
  assert.equal(promptText(null), "");
  assert.equal(promptText(7), "7");
});

test("renderBrief: terminology descriptor render survives a non-string term/suggestion without throwing", () => {
  // Mirrors the exact GITTENSORY-15 stack trace: registry.ts's "terminology" descriptor template calls
  // safeCodeSpan(item.term) and safeCodeSpan(item.suggestion) directly (no template-literal coercion), unlike
  // the `${item.file}:${item.line}` interpolation just before it. Simulates a malformed finding (e.g. from a
  // future config-driven term table or an upstream payload drift) reaching the render path unchanged.
  assert.doesNotThrow(() => {
    // Cast through `any` (not `@ts-expect-error`) since test/**/*.ts is outside tsconfig.json's "src"-only
    // include and is run via --experimental-strip-types (no type-check on test files) -- an unused
    // `@ts-expect-error` here would be inert, not a compile guard.
    const malformedFinding = { file: "src/net.ts", line: 1, term: undefined, suggestion: 42 };
    const { promptSection } = renderBrief({
      terminology: [malformedFinding],
    });
    assert.match(promptSection, /Non-inclusive terminology/);
    assert.match(promptSection, /src\/net\.ts:1/);
    assert.match(promptSection, /``/); // the coerced-empty term renders as an empty code span
    assert.match(promptSection, /`42`/); // the coerced-number suggestion renders as `42`
  });
});

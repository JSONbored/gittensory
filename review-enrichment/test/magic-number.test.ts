// Units for the magic-number analyzer (#2018). Own file so concurrent analyzer PRs do not collide. Pure local
// scanner: no network, no checkout, and every assertion runs against the compiled dist output.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectMagicNumbers,
  extractNumericTokens,
  isAllowedMagicNumberValue,
  isMagicNumberSourcePath,
  scanMagicNumbers,
  scanPatchForMagicNumbers,
} from "../dist/analyzers/magic-number.js";
import { buildBrief } from "../dist/brief.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;

test("isMagicNumberSourcePath: accepts non-test source extensions used by REES analyzers", () => {
  for (const path of [
    "src/app.ts",
    "src/app.tsx",
    "src/app.mts",
    "src/app.cts",
    "src/app.js",
    "src/app.jsx",
    "src/app.mjs",
    "src/app.cjs",
    "pkg/app.py",
    "pkg/app.go",
    "pkg/app.rb",
    "lib/app.dart",
    "src/App.java",
    "src/App.kt",
    "src/App.kts",
    "src/App.scala",
    "src/App.groovy",
    "src/App.cs",
    "src/App.swift",
    "src/App.php",
    "src/lib.rs",
    "src/app.c",
    "src/app.cc",
    "src/app.cpp",
    "src/app.h",
    "src/app.hpp",
  ]) {
    assert.equal(isMagicNumberSourcePath(path), true, path);
  }
});

test("isMagicNumberSourcePath: skips tests, snapshots, docs, config, and generated data files", () => {
  for (const path of [
    "test/app.ts",
    "tests/app.py",
    "spec/app.rb",
    "src/__tests__/app.js",
    "src/app.test.ts",
    "src/app.spec.js",
    "pkg/app_test.go",
    "pkg/test_app.py",
    "lib/app_test.dart",
    "src/AppTest.java",
    "src/app.cy.ts",
    "src/app.e2e.js",
    "src/__snapshots__/app.snap",
    "README.md",
    "package.json",
    "schema.yaml",
    "fixtures/data.txt",
  ]) {
    assert.equal(isMagicNumberSourcePath(path), false, path);
  }
});

test("extractNumericTokens: finds decimal, signed, fractional, exponent, bigint, and radix literals", () => {
  assert.deepEqual(
    extractNumericTokens("return -42 + 3.14 + .5 + 6e-3 + 99n + 0xff + 0b1010 + 0o77;").map((token) => token.value),
    ["-42", "3.14", ".5", "6e-3", "99n", "0xff", "0b1010", "0o77"],
  );
});

test("extractNumericTokens: skips identifiers, property suffixes, and malformed radix prefixes", () => {
  assert.deepEqual(
    extractNumericTokens("v2 + thing42 + obj.404 + 0x + 0b + 0o + next_7").map((token) => token.value),
    [],
  );
});

test("extractNumericTokens: treats signs as numeric only in expression-start positions", () => {
  assert.deepEqual(extractNumericTokens("return value-7 + (-8) + x + +9;").map((token) => token.value), [
    "7",
    "-8",
    "+9",
  ]);
});

test("isAllowedMagicNumberValue: suppresses trivial sentinels and common scales", () => {
  for (const value of ["0", "-0", "1", "-1", "+1", "2", "-2", "100", "1000", "10", "10000", "1_000"]) {
    assert.equal(isAllowedMagicNumberValue(value), true, value);
  }
});

test("isAllowedMagicNumberValue: suppresses equivalent radix representations of common scales", () => {
  for (const value of ["0x0", "0x1", "0x2", "0x64", "0b10", "0o144"]) {
    assert.equal(isAllowedMagicNumberValue(value), true, value);
  }
});

test("isAllowedMagicNumberValue: reports non-trivial values across number syntaxes", () => {
  for (const value of ["3", "-3", "42", "255", "0xff", "0b1011", "0o77", "3.14", "6e-3", "99n"]) {
    assert.equal(isAllowedMagicNumberValue(value), false, value);
  }
});

test("detectMagicNumbers: reports genuine expression literals", () => {
  assert.deepEqual(detectMagicNumbers("const timeoutMs = attempts * 37 + jitter(13);"), [
    { value: "37" },
    { value: "13" },
  ]);
});

test("detectMagicNumbers: ignores strings and trailing comments before scanning", () => {
  assert.deepEqual(detectMagicNumbers('logger.info("wait 37 seconds"); // retry in 42 seconds'), []);
  assert.deepEqual(detectMagicNumbers("return attempts * 19;"), [{ value: "19" }]);
});

test("detectMagicNumbers: ignores named constant declarations", () => {
  for (const line of [
    "const MAX_RETRY_DELAY_MS = 37;",
    "export const MAX_BATCH_SIZE = 500;",
    "static readonly DEFAULT_WINDOW_DAYS = 90;",
    "public static final int RETRY_WINDOW = 30;",
    "final DEFAULT_LIMIT = 50;",
    "val MAX_PAGE_SIZE = 250",
  ]) {
    assert.deepEqual(detectMagicNumbers(line), [], line);
  }
});

test("detectMagicNumbers: does not suppress ordinary lower-case assignments", () => {
  assert.deepEqual(detectMagicNumbers("const timeoutMs = 37;"), [{ value: "37" }]);
  assert.deepEqual(detectMagicNumbers("let retryWindow = 45;"), [{ value: "45" }]);
});

test("detectMagicNumbers: ignores array indexes but reports values used in the indexed expression", () => {
  assert.deepEqual(detectMagicNumbers("return rows[3] + columns[index + 7];"), [{ value: "7" }]);
});

test("detectMagicNumbers: ignores enum-like member initializers", () => {
  assert.deepEqual(detectMagicNumbers("PENDING = 3,"), []);
  assert.deepEqual(detectMagicNumbers("  Done = 4"), []);
  assert.deepEqual(detectMagicNumbers("value = 5"), [{ value: "5" }]);
});

test("detectMagicNumbers: ignores numeric object keys but reports numeric values", () => {
  assert.deepEqual(detectMagicNumbers("return { 404: handler, 503: fallback, retryAfter: 37 };"), [{ value: "37" }]);
});

test("detectMagicNumbers: ignores allowlisted values while preserving non-trivial siblings", () => {
  assert.deepEqual(detectMagicNumbers("return [0, 1, -1, 2, 100, 1000, 10, 25, 1_500];"), [
    { value: "25" },
    { value: "1_500" },
  ]);
});

test("detectMagicNumbers: skips pathologically long lines defensively", () => {
  assert.deepEqual(detectMagicNumbers(`const x = ${"1".repeat(2100)};`), []);
});

test("scanPatchForMagicNumbers: flags added lines with correct new-file locations", () => {
  const findings = scanPatchForMagicNumbers(
    "src/retry.ts",
    patchOf([
      "export function backoff(attempt: number) {",
      "  const delay = attempt * 37;",
      "  return Math.min(delay, 250);",
      "}",
    ]),
  );
  assert.deepEqual(findings, [
    { file: "src/retry.ts", line: 2, value: "37" },
    { file: "src/retry.ts", line: 3, value: "250" },
  ]);
});

test("scanPatchForMagicNumbers: removed lines are ignored and hunk cursor stays correct", () => {
  const patch = [
    "@@ -10,4 +10,4 @@",
    " export function retry() {", // line 10
    "-  return oldValue * 37;",
    "+  return newValue * 43;", // line 11
    " }", // line 12
    "\\ No newline at end of file",
    "@@ -30,2 +30,3 @@",
    " function more() {", // line 30
    "+  return 256;", // line 31
    " }", // line 32
  ].join("\n");
  assert.deepEqual(scanPatchForMagicNumbers("src/retry.ts", patch), [
    { file: "src/retry.ts", line: 11, value: "43" },
    { file: "src/retry.ts", line: 31, value: "256" },
  ]);
});

test("scanPatchForMagicNumbers: added content that starts with plus signs is not mistaken for a file header", () => {
  const patch = ["@@ -1,0 +1,2 @@", "+++counter += 33;", "+return value;"].join("\n");
  assert.deepEqual(scanPatchForMagicNumbers("src/counter.ts", patch), [
    { file: "src/counter.ts", line: 1, value: "33" },
  ]);
});

test("scanPatchForMagicNumbers: skips test files even when they contain reportable values", () => {
  assert.deepEqual(scanPatchForMagicNumbers("src/retry.test.ts", patchOf(["expect(delay).toBe(37);"])), []);
  assert.deepEqual(scanPatchForMagicNumbers("tests/retry.py", patchOf(["assert delay == 37"])), []);
});

test("scanPatchForMagicNumbers: skips non-source files", () => {
  assert.deepEqual(scanPatchForMagicNumbers("README.md", patchOf(["Use 37 workers in the example."])), []);
  assert.deepEqual(scanPatchForMagicNumbers("package.json", patchOf(['"port": 3377'])), []);
});

test("scanPatchForMagicNumbers: enforces the maxFindings cap", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `return metric + ${i + 3};`);
  const patch = patchOf(lines);
  assert.equal(scanPatchForMagicNumbers("src/a.ts", patch, { maxFindings: 5 }).length, 5);
  assert.deepEqual(scanPatchForMagicNumbers("src/a.ts", patch, { maxFindings: 0 }), []);
});

test("scanPatchForMagicNumbers: abort signal stops scanning", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => scanPatchForMagicNumbers("src/a.ts", patchOf(["return 37;"]), { signal: controller.signal }),
    /analyzer_aborted/,
  );
});

test("scanMagicNumbers: scans every changed file and honors the global cap", async () => {
  const noisyLines = Array.from({ length: 40 }, (_, i) => `export const value${i} = base + ${i + 3};`);
  const findings = await scanMagicNumbers({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/quiet.ts", patch: patchOf(["const MAX_SIZE = 50;"]) },
      { path: "src/noisy.ts", patch: patchOf(noisyLines) },
      { path: "src/noisy.test.ts", patch: patchOf(["expect(value).toBe(777);"]) },
    ],
  });

  assert.equal(findings.length, 25);
  assert.ok(findings.every((finding) => finding.file === "src/noisy.ts"));
});

test("scanMagicNumbers: no files or patches yields no findings", async () => {
  assert.deepEqual(await scanMagicNumbers({ repoFullName: "octo/repo", prNumber: 1 }), []);
  assert.deepEqual(
    await scanMagicNumbers({ repoFullName: "octo/repo", prNumber: 1, files: [{ path: "src/a.ts" }] }),
    [],
  );
});

test("scanMagicNumbers: abort signal stops the analyzer entrypoint", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      scanMagicNumbers(
        {
          repoFullName: "octo/repo",
          prNumber: 1,
          files: [{ path: "src/a.ts", patch: patchOf(["return 37;"]) }],
        },
        controller.signal,
      ),
    /analyzer_aborted/,
  );
});

test("detectMagicNumbers: strips block and hash comments after string blanking", () => {
  assert.deepEqual(detectMagicNumbers("return value; /* retry in 37 seconds */"), []);
  assert.deepEqual(detectMagicNumbers("return value # retry in 37 seconds"), []);
  assert.deepEqual(detectMagicNumbers("return value + 29; /* cap at 37 */"), [{ value: "29" }]);
});

test("detectMagicNumbers: preserves numbers in template interpolation code but not template prose", () => {
  assert.deepEqual(detectMagicNumbers("logger.debug(`retry in 37 seconds`)"), []);
  assert.deepEqual(detectMagicNumbers("logger.debug(`retry ${attempt + 37}`)"), [{ value: "37" }]);
});

test("detectMagicNumbers: recognizes public static final constants with primitive and reference types", () => {
  assert.deepEqual(detectMagicNumbers("public static final int RETRY_WINDOW = 37;"), []);
  assert.deepEqual(detectMagicNumbers("private static final Duration RETRY_WINDOW = 37;"), []);
  assert.deepEqual(detectMagicNumbers("public static final RETRY_WINDOW = 37;"), [{ value: "37" }]);
});

test("detectMagicNumbers: named constants require an uppercase constant-style name", () => {
  assert.deepEqual(detectMagicNumbers("const MaxRetries = 37;"), [{ value: "37" }]);
  assert.deepEqual(detectMagicNumbers("const MAX_RETRIES = 37;"), []);
  assert.deepEqual(detectMagicNumbers("readonly MAX_RETRIES = 37;"), []);
});

test("detectMagicNumbers: reports numeric thresholds in common boolean and ternary expressions", () => {
  assert.deepEqual(detectMagicNumbers("return latencyMs > 37 && failures < 9 ? 250 : 5;"), [
    { value: "37" },
    { value: "9" },
    { value: "250" },
    { value: "5" },
  ]);
});

test("detectMagicNumbers: reports negative thresholds after expression punctuation", () => {
  assert.deepEqual(detectMagicNumbers("return clamp(value, -37, +43);"), [{ value: "-37" }, { value: "+43" }]);
  assert.deepEqual(detectMagicNumbers("return value - 37;"), [{ value: "37" }]);
});

test("detectMagicNumbers: handles numeric separators without changing the reported literal", () => {
  assert.deepEqual(detectMagicNumbers("return bytes > 65_536 ? 4_096 : 512;"), [
    { value: "65_536" },
    { value: "4_096" },
    { value: "512" },
  ]);
});

test("detectMagicNumbers: ignores object keys only when they are key positions", () => {
  assert.deepEqual(detectMagicNumbers("return { 37: handler, nested: { code: 43 } };"), [{ value: "43" }]);
  assert.deepEqual(detectMagicNumbers("return map.get(37) ?? fallback[43];"), [{ value: "37" }]);
});

test("detectMagicNumbers: ignores enum-like members only at assignment starts", () => {
  assert.deepEqual(detectMagicNumbers("enumValue = STARTED = 37;"), [{ value: "37" }]);
  assert.deepEqual(detectMagicNumbers("STARTED = 37,"), []);
  assert.deepEqual(detectMagicNumbers("  STARTED = 37"), []);
});

test("extractNumericTokens: keeps source spans around accepted tokens", () => {
  assert.deepEqual(extractNumericTokens("return x + 37;"), [{ value: "37", start: 11, end: 13 }]);
  assert.deepEqual(extractNumericTokens("return x + -37;"), [{ value: "-37", start: 11, end: 14 }]);
});

test("scanPatchForMagicNumbers: handles multiple hunks with plus-prefixed content and no-newline marker", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    "+const first = 37;",
    "\\ No newline at end of file",
    "@@ -20,2 +20,2 @@",
    "+++value += 43;",
    "+const second = 250;",
  ].join("\n");
  assert.deepEqual(scanPatchForMagicNumbers("src/multi.ts", patch), [
    { file: "src/multi.ts", line: 1, value: "37" },
    { file: "src/multi.ts", line: 20, value: "43" },
    { file: "src/multi.ts", line: 21, value: "250" },
  ]);
});

test("scanPatchForMagicNumbers: keeps caps local to each call and global at entrypoint", async () => {
  const first = patchOf(Array.from({ length: 20 }, (_, i) => `export const a${i} = base + ${i + 3};`));
  const second = patchOf(Array.from({ length: 20 }, (_, i) => `export const b${i} = base + ${i + 53};`));
  assert.equal(scanPatchForMagicNumbers("src/a.ts", first, { maxFindings: 7 }).length, 7);
  const findings = await scanMagicNumbers({
    repoFullName: "octo/repo",
    prNumber: 3,
    files: [
      { path: "src/a.ts", patch: first },
      { path: "src/b.ts", patch: second },
    ],
  });
  assert.equal(findings.length, 25);
  assert.equal(findings.at(0)?.file, "src/a.ts");
  assert.equal(findings.at(-1)?.file, "src/b.ts");
});

test("scanMagicNumbers: descriptor-compatible request with explicit analyzer subset stays deterministic", async () => {
  const request = {
    repoFullName: "octo/repo",
    prNumber: 4,
    analyzers: ["magicNumber"],
    files: [{ path: "src/signal.ts", patch: patchOf(["return score * 37 + 43;"]) }],
  };
  const first = await buildBrief(request);
  const second = await buildBrief(request);
  assert.deepEqual(first.findings.magicNumber, second.findings.magicNumber);
  assert.equal(first.promptSection, second.promptSection);
});

test("detectMagicNumbers: handles language-specific collection and slicing syntax conservatively", () => {
  assert.deepEqual(detectMagicNumbers("return items[3:37]"), [{ value: "3" }, { value: "37" }]);
  assert.deepEqual(detectMagicNumbers("return items[:37]"), [{ value: "37" }]);
  assert.deepEqual(detectMagicNumbers("return items[37:]"), [{ value: "37" }]);
  assert.deepEqual(detectMagicNumbers("return matrix[2][37]"), []);
});

test("detectMagicNumbers: does not treat decimals as property access or object keys", () => {
  assert.deepEqual(detectMagicNumbers("return ratio > 0.375 ? 3.5 : .25;"), [
    { value: "0.375" },
    { value: "3.5" },
    { value: ".25" },
  ]);
});

test("detectMagicNumbers: keeps hexadecimal and binary masks visible unless they are trivial", () => {
  assert.deepEqual(detectMagicNumbers("return flags & 0xff;"), [{ value: "0xff" }]);
  assert.deepEqual(detectMagicNumbers("return flags & 0b101010;"), [{ value: "0b101010" }]);
  assert.deepEqual(detectMagicNumbers("return flags & 0b10;"), []);
});

test("detectMagicNumbers: ignores numeric-looking version fragments in identifiers", () => {
  assert.deepEqual(detectMagicNumbers("return http2Enabled && ipv6Ready && tls13Ready;"), []);
  assert.deepEqual(detectMagicNumbers("return handlerV2(input) + 37;"), [{ value: "37" }]);
});

test("detectMagicNumbers: reports values in common standard-library calls", () => {
  assert.deepEqual(detectMagicNumbers("return Math.round(value * 37) / 43;"), [{ value: "37" }, { value: "43" }]);
  assert.deepEqual(detectMagicNumbers("return setTimeout(fn, 250);"), [{ value: "250" }]);
  assert.deepEqual(detectMagicNumbers("return timedelta(seconds=37)"), [{ value: "37" }]);
});

test("detectMagicNumbers: supports signed exponents and BigInt suffixes", () => {
  assert.deepEqual(detectMagicNumbers("return 6.25e-3 + 99n + -12n;"), [
    { value: "6.25e-3" },
    { value: "99n" },
    { value: "-12n" },
  ]);
});

test("detectMagicNumbers: trims reported literals to the public brief cap", () => {
  const longLiteral = "9".repeat(80);
  const [finding] = detectMagicNumbers(`return ${longLiteral};`);
  assert.equal(finding.value, "9".repeat(40));
});

test("scanPatchForMagicNumbers: respects source path gating across mixed-language patches", () => {
  const patch = patchOf(["return threshold + 37;"]);
  assert.deepEqual(scanPatchForMagicNumbers("src/a.rs", patch), [{ file: "src/a.rs", line: 1, value: "37" }]);
  assert.deepEqual(scanPatchForMagicNumbers("src/a.swift", patch), [{ file: "src/a.swift", line: 1, value: "37" }]);
  assert.deepEqual(scanPatchForMagicNumbers("src/a.yaml", patch), []);
});

test("scanPatchForMagicNumbers: handles hunk start line zero and empty hunk bodies", () => {
  assert.deepEqual(scanPatchForMagicNumbers("src/generated.ts", "@@ -0,0 +0,0 @@"), []);
  assert.deepEqual(scanPatchForMagicNumbers("src/zero.ts", "@@ -0,0 +0,1 @@\n+return 37;"), [
    { file: "src/zero.ts", line: 0, value: "37" },
  ]);
});

test("scanPatchForMagicNumbers: skips preamble additions until the first real hunk", () => {
  const patch = ["+return 37;", "diff --git a/src/a.ts b/src/a.ts", "@@ -1,0 +10,1 @@", "+return 43;"].join("\n");
  assert.deepEqual(scanPatchForMagicNumbers("src/a.ts", patch), [{ file: "src/a.ts", line: 10, value: "43" }]);
});

test("scanPatchForMagicNumbers: one added line can emit several findings with the same location", () => {
  assert.deepEqual(scanPatchForMagicNumbers("src/many.ts", patchOf(["return 37 + 43 + 59;"])), [
    { file: "src/many.ts", line: 1, value: "37" },
    { file: "src/many.ts", line: 1, value: "43" },
    { file: "src/many.ts", line: 1, value: "59" },
  ]);
});

test("scanPatchForMagicNumbers: ignores binary-file and no-patch markers", () => {
  assert.deepEqual(scanPatchForMagicNumbers("src/image.ts", "Binary files differ"), []);
  assert.deepEqual(scanPatchForMagicNumbers("src/empty.ts", ""), []);
  assert.deepEqual(scanPatchForMagicNumbers("src/empty.ts", undefined), []);
});

test("scanPatchForMagicNumbers: preserves hunk cursor through deleted and context lines", () => {
  const patch = [
    "@@ -10,4 +20,5 @@",
    " const baseline = 37;",
    "-return retry + 43;",
    "+return retry + 59;",
    " const after = 61;",
    "+return after + 67;",
  ].join("\n");

  assert.deepEqual(scanPatchForMagicNumbers("src/cursor.ts", patch), [
    { file: "src/cursor.ts", line: 21, value: "59" },
    { file: "src/cursor.ts", line: 23, value: "67" },
  ]);
});

test("scanMagicNumbers: skips files without usable patches while scanning later files", async () => {
  const findings = await scanMagicNumbers({
    repoFullName: "octo/repo",
    prNumber: 9,
    files: [
      { path: "src/no-patch.ts" },
      { path: "src/skip.md", patch: patchOf(["return 37;"]) },
      { path: "src/ok.ts", patch: patchOf(["return 43;"]) },
    ],
  });

  assert.deepEqual(findings, [{ file: "src/ok.ts", line: 1, value: "43" }]);
});

test("buildBrief: magicNumber participates in default registry when explicitly requested with another local analyzer", async () => {
  const brief = await buildBrief({
    repoFullName: "octo/repo",
    prNumber: 5,
    analyzers: ["magicNumber", "todoMarker"],
    files: [{ path: "src/a.ts", patch: patchOf(["// TODO: explain retry", "return attempts * 37;"]) }],
  });

  assert.equal(brief.analyzerStatus.magicNumber, "ok");
  assert.equal(brief.analyzerStatus.todoMarker, "ok");
  assert.deepEqual(brief.findings.magicNumber, [{ file: "src/a.ts", line: 2, value: "37" }]);
  assert.deepEqual(brief.findings.todoMarker, [{ file: "src/a.ts", line: 1, tag: "TODO", note: "explain retry" }]);
  assert.match(brief.promptSection, /Magic numbers/);
  assert.match(brief.promptSection, /Incomplete-work markers/);
});

test("renderBrief: magic-number output is public-safe and does not include surrounding source", () => {
  const { promptSection } = renderBrief({
    magicNumber: [{ file: "src/retry.ts", line: 7, value: "37" }],
  });
  assert.match(promptSection, /src\/retry\.ts:7/);
  assert.match(promptSection, /37/);
  assert.doesNotMatch(promptSection, /attempt/);
  assert.doesNotMatch(promptSection, /return/);
});

test("buildBrief: descriptor registry runs magicNumber explicitly", async () => {
  const brief = await buildBrief({
    repoFullName: "octo/repo",
    prNumber: 2,
    analyzers: ["magicNumber"],
    files: [{ path: "src/backoff.ts", patch: patchOf(["export const wait = attempt * 37;"]) }],
  });

  assert.equal(brief.partial, false);
  assert.equal(brief.analyzerStatus.magicNumber, "ok");
  assert.deepEqual(brief.findings.magicNumber, [{ file: "src/backoff.ts", line: 1, value: "37" }]);
  assert.match(brief.promptSection, /Magic numbers/);
});

test("renderBrief: magic-number findings render location and literal value", () => {
  const { promptSection } = renderBrief({
    magicNumber: [
      { file: "src/retry.ts", line: 7, value: "37" },
      { file: "src/cache.ts", line: 9, value: "250" },
    ],
  });
  assert.match(promptSection, /Magic numbers/);
  assert.match(promptSection, /src\/retry\.ts:7/);
  assert.match(promptSection, /37/);
  assert.match(promptSection, /src\/cache\.ts:9/);
});

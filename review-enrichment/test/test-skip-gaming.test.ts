// Units for the test-skip-gaming analyzer. Own file (not enrichment.test.ts) so concurrent analyzer PRs don't
// collide. No network involved — pure compute over added patch lines. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTestSkipGamingRelevantPath,
  scanPatchForTestSkipGaming,
  scanTestSkipGaming,
} from "../dist/analyzers/test-skip-gaming.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("isTestSkipGamingRelevantPath: recognizes test-path conventions and workflow files, not ordinary source", () => {
  assert.equal(isTestSkipGamingRelevantPath("test/unit/foo.test.ts"), true);
  assert.equal(isTestSkipGamingRelevantPath("src/test/java/com/example/FooTest.java"), true);
  assert.equal(isTestSkipGamingRelevantPath(".github/workflows/ci.yml"), true);
  assert.equal(isTestSkipGamingRelevantPath("src/services/scoring.ts"), false);
});

// --- Rule 1/2: skip and narrowing markers in test files ------------------------------------------------------

test("scanPatchForTestSkipGaming: flags every JS/TS skip form (it/test/describe.skip, x-prefixed)", () => {
  const findings = scanPatchForTestSkipGaming(
    "test/unit/foo.test.ts",
    patchOf([
      "it.skip(\"is skipped\", () => {});",
      "test.skip(\"is skipped\", () => {});",
      "describe.skip(\"suite\", () => {});",
      "xdescribe(\"suite\", () => {});",
      "xit(\"is skipped\", () => {});",
      "xtest(\"is skipped\", () => {});",
    ]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    Array(6).fill("skip-marker"),
  );
  assert.deepEqual(
    findings.map((f) => f.line),
    [1, 2, 3, 4, 5, 6],
  );
});

test("scanPatchForTestSkipGaming: flags every JS/TS narrowing form (it/test/describe.only, fit/fdescribe)", () => {
  const findings = scanPatchForTestSkipGaming(
    "test/unit/foo.test.ts",
    patchOf([
      "it.only(\"focused\", () => {});",
      "test.only(\"focused\", () => {});",
      "describe.only(\"suite\", () => {});",
      "fit(\"focused\", () => {});",
      "fdescribe(\"suite\", () => {});",
    ]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    Array(5).fill("only-marker"),
  );
});

test("scanPatchForTestSkipGaming: an ordinary it/describe call with no marker is not flagged", () => {
  const findings = scanPatchForTestSkipGaming(
    "test/unit/foo.test.ts",
    patchOf([
      "it(\"does the thing\", () => {});",
      "describe(\"suite\", () => {});",
      "test(\"also fine\", () => {});",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForTestSkipGaming: identifiers that merely end in the marker word are not flagged (word-boundary precision)", () => {
  // `profit(` must not match `fit(`, and a real helper like `fitCurve(` must not match either — the marker
  // requires the exact focused-test call shape, not any identifier ending in the same letters.
  const findings = scanPatchForTestSkipGaming(
    "test/unit/foo.test.ts",
    patchOf(["const result = profit(data);", "fitCurve(points);"]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForTestSkipGaming: flags Python's @pytest.mark.skip and @pytest.mark.skipif", () => {
  const findings = scanPatchForTestSkipGaming(
    "test_foo.py",
    patchOf(["@pytest.mark.skip", "def test_disabled(): pass", "@pytest.mark.skipif(True, reason=\"flaky\")"]),
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["skip-marker", "skip-marker"],
  );
  assert.deepEqual(
    findings.map((f) => f.line),
    [1, 3],
  );
});

test("scanPatchForTestSkipGaming: an unrelated pytest marker is not flagged", () => {
  const findings = scanPatchForTestSkipGaming(
    "test_foo.py",
    patchOf(["@pytest.mark.parametrize(\"x\", [1, 2, 3])"]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForTestSkipGaming: flags JUnit's @Disabled but not @DisabledIfSystemProperty", () => {
  const findings = scanPatchForTestSkipGaming(
    "src/test/java/com/example/FooTest.java",
    patchOf(["@Disabled", "void testDisabled() {}", "@DisabledIfSystemProperty(named = \"ci\", matches = \"true\")"]),
  );
  assert.deepEqual(findings, [
    { file: "src/test/java/com/example/FooTest.java", line: 1, kind: "skip-marker" },
  ]);
});

test("scanPatchForTestSkipGaming: flags Go's t.Skip( but not the unrelated t.Skipf(", () => {
  const findings = scanPatchForTestSkipGaming(
    "pkg/foo_test.go",
    patchOf(["t.Skip(\"not ready\")", "t.Skipf(\"not ready: %s\", reason)"]),
  );
  assert.deepEqual(findings, [{ file: "pkg/foo_test.go", line: 1, kind: "skip-marker" }]);
});

test("scanPatchForTestSkipGaming: a test path with no recognized language extension yields no findings", () => {
  const findings = scanPatchForTestSkipGaming("test/README", patchOf(["it.skip(\"x\", () => {});"]));
  assert.deepEqual(findings, []);
});

test("scanPatchForTestSkipGaming: only ADDED lines are scanned — removing a pre-existing skip marker is not flagged", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    "-it.skip(\"was skipped\", () => {});",
    "+it(\"now runs\", () => {});",
  ].join("\n");
  assert.deepEqual(scanPatchForTestSkipGaming("test/unit/foo.test.ts", patch), []);
});

test("scanPatchForTestSkipGaming: a pre-existing marker shown only as unchanged context is not flagged", () => {
  const patch = [
    "@@ -1,3 +1,3 @@",
    " it.skip(\"already skipped, untouched by this diff\", () => {});",
    "-it(\"old\", () => {});",
    "+it(\"new\", () => {});",
  ].join("\n");
  assert.deepEqual(scanPatchForTestSkipGaming("test/unit/foo.test.ts", patch), []);
});

test("scanPatchForTestSkipGaming: new-file line numbers stay correct across context and removed lines", () => {
  const patch = [
    "@@ -10,2 +10,2 @@",
    " describe(\"suite\", () => {", // new-file line 10
    "-  it(\"old\", () => {});",
    "+  it.skip(\"new\", () => {});", // new-file line 11
  ].join("\n");
  const findings = scanPatchForTestSkipGaming("test/unit/foo.test.ts", patch);
  assert.deepEqual(findings, [{ file: "test/unit/foo.test.ts", line: 11, kind: "skip-marker" }]);
});

test("scanPatchForTestSkipGaming: enforces the maxFindings cap on test-file markers", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `it.skip("case ${i}", () => {});`);
  const findings = scanPatchForTestSkipGaming("test/unit/foo.test.ts", patchOf(lines), { maxFindings: 5 });
  assert.equal(findings.length, 5);
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3, 4, 5]);

  assert.deepEqual(
    scanPatchForTestSkipGaming("test/unit/foo.test.ts", patchOf(lines), { maxFindings: 0 }),
    [],
  );
});

test("scanPatchForTestSkipGaming: an aborted signal throws while scanning a test file", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      scanPatchForTestSkipGaming("test/unit/foo.test.ts", patchOf(["it.skip(\"x\", () => {});"]), {
        signal: controller.signal,
      }),
    /analyzer_aborted/,
  );
});

// --- Rule 3: CI workflow steps neutered with continue-on-error / literal if: false ---------------------------

const workflowPatch = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.join("\n")}`;

test("scanPatchForTestSkipGaming: flags a test step that newly gains continue-on-error: true", () => {
  const findings = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch([
      "       - name: Run tests",
      "         run: npm test",
      "+        continue-on-error: true",
    ]),
  );
  assert.deepEqual(findings, [
    { file: ".github/workflows/ci.yml", line: 3, kind: "ci-continue-on-error" },
  ]);
});

test("scanPatchForTestSkipGaming: flags a test step that newly gains a literal if: false", () => {
  const findings = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch(["       - name: Run tests", "         run: npm test", "+        if: false"]),
  );
  assert.deepEqual(findings, [
    { file: ".github/workflows/ci.yml", line: 3, kind: "ci-neutralized-if" },
  ]);
});

test("scanPatchForTestSkipGaming: quoted 'true'/\"false\" forms are recognized the same as bare booleans", () => {
  const continueOnError = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch(["       - run: pytest", "+        continue-on-error: 'true'"]),
  );
  assert.deepEqual(
    continueOnError.map((f) => f.kind),
    ["ci-continue-on-error"],
  );

  const neutralizedIf = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch(["       - run: go test ./...", '+        if: "false"']),
  );
  assert.deepEqual(
    neutralizedIf.map((f) => f.kind),
    ["ci-neutralized-if"],
  );
});

test("scanPatchForTestSkipGaming: continue-on-error/if gained on a NON-test step is not flagged", () => {
  const findings = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch([
      "       - name: Build",
      "         run: npm run build",
      "+        continue-on-error: true",
      "       - name: Notify",
      "         run: echo done",
      "+        if: false",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForTestSkipGaming: continue-on-error: false and a real conditional (if: failure()) are not flagged", () => {
  const findings = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch([
      "       - name: Run tests",
      "         run: npm test",
      "+        continue-on-error: false",
      "+        if: failure()",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForTestSkipGaming: an already-true continue-on-error shown only as context is not flagged", () => {
  const findings = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch([
      "       - name: Run tests",
      "         run: npm test",
      "         continue-on-error: true",
      "+        timeout-minutes: 5",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForTestSkipGaming: removing a pre-existing continue-on-error is a fix, not gaming", () => {
  const patch = [
    "@@ -1,3 +1,2 @@",
    "       - name: Run tests",
    "         run: npm test",
    "-        continue-on-error: true",
  ].join("\n");
  assert.deepEqual(scanPatchForTestSkipGaming(".github/workflows/ci.yml", patch), []);
});

test("scanPatchForTestSkipGaming: step isolation — a sibling step's gain and test command don't leak into each other", () => {
  const findings = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch([
      "       - name: Build",
      "         run: npm run build",
      "+        continue-on-error: true", // gains on a non-test step: not flagged
      "       - name: Run tests",
      "         run: npm test",
      "+        if: false", // gains on the real test step: flagged
    ]),
  );
  assert.deepEqual(findings, [
    { file: ".github/workflows/ci.yml", line: 6, kind: "ci-neutralized-if" },
  ]);
});

test("scanPatchForTestSkipGaming: state does not leak across a hunk boundary", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    "       - name: Run tests",
    "         run: npm test",
    "@@ -50,1 +51,2 @@",
    // A new hunk far away: no run: line in view, so this step is unknown — the gain must not be flagged.
    "       - name: Deploy",
    "+        continue-on-error: true",
  ].join("\n");
  assert.deepEqual(scanPatchForTestSkipGaming(".github/workflows/ci.yml", patch), []);
});

test("scanPatchForTestSkipGaming: an overly long run: line is skipped, so the step is never marked as running tests", () => {
  const longComment = "a".repeat(2100);
  const findings = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch([
      "       - name: Run tests",
      `         run: npm test # ${longComment}`,
      "+        continue-on-error: true",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForTestSkipGaming: recognizes other ecosystems' test commands (pytest, go test, mvn test)", () => {
  const pytestFinding = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch(["       - run: pytest -v", "+        continue-on-error: true"]),
  );
  assert.equal(pytestFinding.length, 1);

  const goTestFinding = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch(["       - run: go test ./...", "+        if: false"]),
  );
  assert.equal(goTestFinding.length, 1);

  const mvnFinding = scanPatchForTestSkipGaming(
    ".github/workflows/ci.yml",
    workflowPatch(["       - run: mvn -B test", "+        continue-on-error: true"]),
  );
  assert.equal(mvnFinding.length, 1);
});

test("scanPatchForTestSkipGaming: enforces the maxFindings cap across multiple neutered test steps", () => {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(`       - name: Run tests ${i}`, "         run: npm test", "+        continue-on-error: true");
  }
  const findings = scanPatchForTestSkipGaming(".github/workflows/ci.yml", workflowPatch(lines), {
    maxFindings: 2,
  });
  assert.equal(findings.length, 2);
});

test("scanPatchForTestSkipGaming: an aborted signal throws while scanning a workflow file", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      scanPatchForTestSkipGaming(
        ".github/workflows/ci.yml",
        workflowPatch(["       - run: npm test", "+        continue-on-error: true"]),
        { signal: controller.signal },
      ),
    /analyzer_aborted/,
  );
});

// --- Dispatch and the analyzer entrypoint ---------------------------------------------------------------------

test("scanPatchForTestSkipGaming: an ordinary source file (neither test nor workflow) yields no findings", () => {
  assert.deepEqual(
    scanPatchForTestSkipGaming("src/services/scoring.ts", patchOf(["it.skip(\"x\", () => {});"])),
    [],
  );
});

test("scanTestSkipGaming: scans only relevant paths and aggregates across test and workflow files", async () => {
  const findings = await scanTestSkipGaming({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/app.ts", patch: patchOf(["it.skip(\"not scanned here\", () => {});"]) },
      { path: "test/unit/foo.test.ts", patch: patchOf(["xit(\"skipped\", () => {});"]) },
      {
        path: ".github/workflows/ci.yml",
        patch: workflowPatch(["       - run: npm test", "+        if: false"]),
      },
      { path: "test/unit/bar.test.ts" }, // no patch — skipped
    ],
  });
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.kind}`),
    ["test/unit/foo.test.ts:skip-marker", ".github/workflows/ci.yml:ci-neutralized-if"],
  );
});

test("scanTestSkipGaming: honors the global cap across multiple files", async () => {
  const skipLines = Array.from({ length: 15 }, (_, i) => `it.skip("case ${i}", () => {});`);
  const findings = await scanTestSkipGaming({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "test/unit/a.test.ts", patch: patchOf(skipLines) },
      { path: "test/unit/b.test.ts", patch: patchOf(skipLines) },
    ],
  });
  assert.equal(findings.length, 25); // capped at MAX_FINDINGS across both files
  assert.equal(findings.filter((f) => f.file === "test/unit/b.test.ts").length, 10);
});

test("scanTestSkipGaming: no files yields no findings", async () => {
  assert.deepEqual(await scanTestSkipGaming({ repoFullName: "octo/repo", prNumber: 1 }), []);
});

test("scanTestSkipGaming: an aborted signal throws immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    scanTestSkipGaming(
      {
        repoFullName: "octo/repo",
        prNumber: 1,
        files: [{ path: "test/unit/a.test.ts", patch: patchOf(["it.skip(\"x\", () => {});"]) }],
      },
      controller.signal,
    ),
    /analyzer_aborted/,
  );
});

test("renderBrief: test-skip-gaming findings render location plus a public-safe explanation per kind", () => {
  const { promptSection } = renderBrief({
    testSkipGaming: [
      { file: "test/unit/foo.test.ts", line: 3, kind: "skip-marker" },
      { file: "test/unit/bar.test.ts", line: 7, kind: "only-marker" },
      { file: ".github/workflows/ci.yml", line: 12, kind: "ci-continue-on-error" },
      { file: ".github/workflows/ci.yml", line: 20, kind: "ci-neutralized-if" },
    ],
  });
  assert.match(promptSection, /Test-skip gaming/);
  assert.match(promptSection, /test\/unit\/foo\.test\.ts:3/);
  assert.match(promptSection, /never actually runs/);
  assert.match(promptSection, /excludes sibling tests/);
  assert.match(promptSection, /can no longer fail the check/);
  assert.match(promptSection, /never runs at all/);
});

test("renderBrief: no test-skip-gaming findings renders nothing for the section", () => {
  const { promptSection } = renderBrief({ testSkipGaming: [] });
  assert.doesNotMatch(promptSection, /Test-skip gaming/);
});

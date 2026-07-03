// Units for the risky-workflow-permissions analyzer. Kept separate so analyzer PRs avoid collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scanPatchForWorkflowPermissions,
  scanWorkflowPermissions,
  stripYamlComment,
} from "../dist/analyzers/workflow-permissions.js";

const workflowPath = ".github/workflows/ci.yml";

const addedPatch = (...lines) =>
  `@@ -1,0 +5,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("scanPatchForWorkflowPermissions flags each risky permission and trigger kind", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch(
      "on: pull_request_target",
      "  permissions: write-all",
      "      id-token: write",
      "      contents: write",
      "    secrets: inherit",
      "on: workflow_run",
    ),
  );
  assert.deepEqual(findings, [
    { file: workflowPath, line: 5, kind: "pull-request-target-trigger" },
    { file: workflowPath, line: 6, kind: "write-all-permission" },
    { file: workflowPath, line: 7, kind: "oidc-token-write" },
    {
      file: workflowPath,
      line: 8,
      kind: "sensitive-scope-write",
      detail: "contents",
    },
    { file: workflowPath, line: 9, kind: "secrets-inherit" },
    { file: workflowPath, line: 10, kind: "workflow-run-trigger" },
  ]);
});

test("scanPatchForWorkflowPermissions captures each sensitive scope name", () => {
  for (const scope of [
    "packages",
    "actions",
    "deployments",
    "security-events",
  ]) {
    const findings = scanPatchForWorkflowPermissions(
      workflowPath,
      addedPatch(`      ${scope}: write`),
    );
    assert.deepEqual(findings, [
      { file: workflowPath, line: 5, kind: "sensitive-scope-write", detail: scope },
    ]);
  }
});

test("scanPatchForWorkflowPermissions does not mis-flag a job/step id that shares a trigger's name", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch(
      "jobs:",
      "  workflow_run:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - id: pull_request_target",
      "        run: echo hi",
    ),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowPermissions flags a block-mapping trigger declared under on:", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch("on:", "  pull_request_target:", "  workflow_run:", "    types: [completed]"),
  );
  assert.deepEqual(findings, [
    { file: workflowPath, line: 6, kind: "pull-request-target-trigger" },
    { file: workflowPath, line: 7, kind: "workflow-run-trigger" },
  ]);
});

test("scanPatchForWorkflowPermissions does not flag a trigger name nested deeper than the on: block's direct children", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch(
      "on:",
      "  workflow_call:",
      "    inputs:",
      "      pull_request_target:",
      "        type: string",
    ),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowPermissions stops treating keys as on:-block children once a sibling top-level key starts", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch("on:", "  push:", "jobs:", "  pull_request_target:", "    runs-on: ubuntu-latest"),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowPermissions does not flag a same-line on: trigger unless on: is at column 0", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch("jobs:", "  foo:", "    with:", "      on: pull_request_target"),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowPermissions does not treat a nested on: key (non-zero indent) as entering the trigger block", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch("jobs:", "  foo:", "    with:", "      on:", "        pull_request_target:"),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowPermissions does not carry on:-block context across a hunk gap", () => {
  const patch = [
    "@@ -1,1 +1,1 @@",
    " on:",
    "@@ -10,1 +10,1 @@",
    "+  pull_request_target:",
  ].join("\n");
  const findings = scanPatchForWorkflowPermissions(workflowPath, patch);
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowPermissions ignores read grants and comments", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch(
      "  permissions: read-all",
      "      contents: read",
      "  # pull_request_target is risky — do not use",
      "  name: workflow_run mentioned in a value # id-token: write",
    ),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowPermissions does not mis-flag an actions/* uses ref as an actions:write grant", () => {
  const findings = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch("    - uses: actions/checkout@v4", "    - uses: actions/setup-node@v4"),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForWorkflowPermissions tracks new-file lines and skips removed/context lines", () => {
  const patch = [
    "@@ -1,2 +1,3 @@",
    " on:",
    "-  - push",
    "+  - pull_request_target",
  ].join("\n");
  const findings = scanPatchForWorkflowPermissions(workflowPath, patch);
  assert.deepEqual(findings, [
    { file: workflowPath, line: 2, kind: "pull-request-target-trigger" },
  ]);
});

test("scanPatchForWorkflowPermissions dedupes a kind per line and honors the budget", () => {
  assert.deepEqual(
    scanPatchForWorkflowPermissions(workflowPath, addedPatch("permissions: write-all"), {
      maxFindings: 0,
    }),
    [],
  );
  const capped = scanPatchForWorkflowPermissions(
    workflowPath,
    addedPatch("permissions: write-all", "  id-token: write", "  contents: write"),
    { maxFindings: 2 },
  );
  assert.equal(capped.length, 2);
});

test("scanPatchForWorkflowPermissions skips pathologically long lines", () => {
  const long = `permissions: write-all ${"x".repeat(2001)}`;
  assert.deepEqual(
    scanPatchForWorkflowPermissions(workflowPath, addedPatch(long)),
    [],
  );
});

test("stripYamlComment removes a comment tail but keeps a bare value", () => {
  assert.equal(stripYamlComment("  contents: write # needed for release").trim(), "contents: write");
  assert.equal(stripYamlComment("# whole line comment"), "");
  assert.equal(stripYamlComment("  contents: write"), "  contents: write");
});

test("scanWorkflowPermissions scans only workflow files with a patch", async () => {
  const findings = await scanWorkflowPermissions({
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: ".github/workflows/deploy.yml", patch: addedPatch("  permissions: write-all") },
      { path: "src/config.ts", patch: addedPatch("permissions: write-all") }, // not a workflow path
      { path: ".github/workflows/no-patch.yml" }, // no patch
    ],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, ".github/workflows/deploy.yml");
  assert.equal(findings[0].kind, "write-all-permission");
});

test("scanWorkflowPermissions returns [] with no files and throws when aborted", async () => {
  assert.deepEqual(await scanWorkflowPermissions({ repoFullName: "o/r", prNumber: 1 }), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    scanWorkflowPermissions(
      {
        repoFullName: "o/r",
        prNumber: 1,
        files: [{ path: workflowPath, patch: addedPatch("permissions: write-all") }],
      },
      controller.signal,
    ),
    /analyzer_aborted/,
  );
});

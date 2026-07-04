import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scanConflictMarkers,
  scanPatchForConflictMarkers,
} from "../dist/analyzers/conflict-marker.js";

const hunk = (lines) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("scanPatchForConflictMarkers flags each git conflict marker on added lines", () => {
  const findings = scanPatchForConflictMarkers(
    "src/app.ts",
    hunk([
      "<<<<<<< HEAD",
      "const a = 1;",
      "||||||| merged common ancestors",
      "const a = 0;",
      "=======",
      "const a = 2;",
      ">>>>>>> feature-branch",
    ]),
  );
  assert.deepEqual(findings, [
    { file: "src/app.ts", line: 1, marker: "<<<<<<<" },
    { file: "src/app.ts", line: 3, marker: "|||||||" },
    { file: "src/app.ts", line: 5, marker: "=======" },
    { file: "src/app.ts", line: 7, marker: ">>>>>>>" },
  ]);
});

test("scanPatchForConflictMarkers does not flag a bare ======= line in Markdown (setext underline / rule)", () => {
  assert.deepEqual(
    scanPatchForConflictMarkers("docs/readme.md", hunk(["Title", "======="])),
    [],
  );
  // ...but the unambiguous ours/theirs markers are still flagged even inside a Markdown file.
  assert.deepEqual(
    scanPatchForConflictMarkers("docs/readme.md", hunk(["<<<<<<< HEAD"])),
    [{ file: "docs/readme.md", line: 1, marker: "<<<<<<<" }],
  );
});

test("scanPatchForConflictMarkers only scans added lines and requires exactly seven characters", () => {
  // A context line carrying a marker shape is not flagged (only added lines count).
  assert.deepEqual(
    scanPatchForConflictMarkers("src/app.ts", "@@ -1,1 +1,1 @@\n =======").length,
    0,
  );
  // Six or eight characters is not a git conflict marker (git writes exactly seven).
  assert.deepEqual(
    scanPatchForConflictMarkers(
      "src/app.ts",
      hunk(["<<<<<<", "<<<<<<<<", "======", "========", ">>>>>>", ">>>>>>>>"]),
    ),
    [],
  );
});

test("scanPatchForConflictMarkers honors the maxFindings cap", () => {
  const findings = scanPatchForConflictMarkers(
    "src/a.ts",
    hunk(["<<<<<<< a", ">>>>>>> b", "<<<<<<< c"]),
    2,
  );
  assert.equal(findings.length, 2);
});

test("scanConflictMarkers scans every changed file and skips the Markdown separator", async () => {
  const findings = await scanConflictMarkers({
    files: [
      { path: "src/a.ts", patch: hunk(["<<<<<<< HEAD"]) },
      { path: "docs/x.md", patch: hunk(["======="]) }, // markup separator: not flagged
      { path: "src/b.ts", patch: hunk([">>>>>>> theirs"]) },
      { path: "src/c.ts" }, // no patch: skipped
    ],
  });
  assert.deepEqual(findings, [
    { file: "src/a.ts", line: 1, marker: "<<<<<<<" },
    { file: "src/b.ts", line: 1, marker: ">>>>>>>" },
  ]);
});

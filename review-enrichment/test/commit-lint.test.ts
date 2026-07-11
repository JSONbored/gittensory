// Units for the conventional-commit subject linter (#2021). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. Network is mocked via an injected fetch. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lintSubject,
  analyzeCommitSubjects,
  scanCommitLint,
} from "../dist/analyzers/commit-lint.js";

const commitsResponse = (subjects) =>
  async () =>
    new Response(
      JSON.stringify(subjects.map((s, i) => ({ sha: `${i}`.padStart(40, "0"), commit: { message: s } }))),
      { status: 200 },
    );
const req = (overrides = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  ...overrides,
});

test("lintSubject: a conforming Conventional-Commit subject passes (with and without scope / breaking marker)", () => {
  assert.equal(lintSubject("feat: add retries"), null);
  assert.equal(lintSubject("fix(parser): handle nulls"), null);
  assert.equal(lintSubject("refactor(core)!: drop legacy path"), null);
  assert.equal(lintSubject("chore: bump deps"), null);
});

test("lintSubject: flags each non-conforming reason", () => {
  assert.equal(lintSubject(""), "empty");
  assert.equal(lintSubject("   "), "empty");
  assert.equal(lintSubject("feat: " + "x".repeat(80)), "too-long");
  assert.equal(lintSubject("just a plain sentence"), "missing-colon");
  assert.equal(lintSubject("Add a feature"), "missing-colon");
  assert.equal(lintSubject("feature: not an allowed type"), "bad-type");
  assert.equal(lintSubject("wip: work in progress"), "bad-type");
});

test("lintSubject: the type check is case-sensitive — the Conventional-Commits set is lowercase", () => {
  // `FEAT`/`Fix` are not the lowercase spec types, so they are flagged as bad-type (not silently accepted).
  assert.equal(lintSubject("FEAT: add thing"), "bad-type");
  assert.equal(lintSubject("Fix: a bug"), "bad-type");
  assert.equal(lintSubject("Chore(ci): tweak"), "bad-type");
});

test("lintSubject: empty and too-long take priority over structural checks", () => {
  // An over-long subject is reported as too-long even if it would also be a bad type.
  assert.equal(lintSubject("nope: " + "y".repeat(80)), "too-long");
});

test("analyzeCommitSubjects: reports only non-conforming subjects with a short sha and truncated subject", () => {
  const findings = analyzeCommitSubjects([
    { sha: "a".repeat(40), commit: { message: "feat: good\n\nbody ignored" } },
    { sha: "b".repeat(40), commit: { message: "bad subject here" } },
    { sha: "c".repeat(40), commit: { message: "wip: nope" } },
  ]);
  assert.deepEqual(findings, [
    { sha: "bbbbbbbbbbbb", subject: "bad subject here", reason: "missing-colon" },
    { sha: "cccccccccccc", subject: "wip: nope", reason: "bad-type" },
  ]);
});

test("analyzeCommitSubjects: lints the SUBJECT line only, ignoring the commit body", () => {
  const findings = analyzeCommitSubjects([
    { sha: "d".repeat(40), commit: { message: "feat: ok\n\nnot: a subject line" } },
  ]);
  assert.deepEqual(findings, []);
});

test("analyzeCommitSubjects: enforces the maxFindings cap and skips items with no sha", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ sha: `${i}`.padStart(40, "0"), commit: { message: "nope" } }));
  assert.equal(analyzeCommitSubjects(items, 5).length, 5);
  assert.deepEqual(analyzeCommitSubjects([{ commit: { message: "nope" } }]), []);
});

test("scanCommitLint: end-to-end flags non-conforming subjects from the fetched commit list", async () => {
  const findings = await scanCommitLint(req(), commitsResponse(["feat: fine", "broken subject"]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "missing-colon");
  assert.equal(findings[0].subject, "broken subject");
});

test("scanCommitLint: fail-safe — no token, a bad repo slug, or a fetch error yields no finding", async () => {
  const good = commitsResponse(["broken"]);
  assert.deepEqual(await scanCommitLint(req({ githubToken: undefined }), good), []);
  assert.deepEqual(await scanCommitLint(req({ repoFullName: "octo/repo/extra" }), good), []);
  assert.deepEqual(await scanCommitLint(req({ repoFullName: "bad slug!/x" }), good), []);
  // ".." individually satisfies a bare `[A-Za-z0-9._-]+` class; only a first-character requirement catches it.
  assert.deepEqual(await scanCommitLint(req({ repoFullName: "../evil" }), good), []);
  const err = async () => new Response("nope", { status: 500 });
  assert.deepEqual(await scanCommitLint(req(), err), []);
});

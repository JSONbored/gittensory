// Units for the unused-export analyzer (#2025). Own file so concurrent analyzer PRs don't collide.
// All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectAddedExports,
  codeSearchQuery,
  fragmentsLookLikeExportDeclaration,
  symbolHasNonDeclarationReference,
  scanUnusedExport,
} from "../dist/analyzers/unused-export.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

const req = (files, extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  headSha: "abc123",
  files,
  ...extra,
});

const searchResponse = (body: unknown, status = 200) =>
  async (url: string) => {
    if (String(url).includes("/search/code")) {
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  };

test("codeSearchQuery: scopes to owner/repo and symbol", () => {
  assert.equal(codeSearchQuery("octo", "repo", "deadHelper"), "repo:octo/repo deadHelper");
});

test("collectAddedExports: gathers direct added exports across files", () => {
  const files = [
    { path: "src/a.ts", patch: patchOf(["export const dead = 1;"]) },
    { path: "src/b.ts", patch: patchOf(["export function live() {}"]) },
  ];
  assert.deepEqual(collectAddedExports(files), [
    { file: "src/a.ts", line: 1, symbol: "dead" },
    { file: "src/b.ts", line: 1, symbol: "live" },
  ]);
});

test("symbolHasNonDeclarationReference: zero hits means unreferenced", () => {
  assert.equal(symbolHasNonDeclarationReference("dead", "src/a.ts", { total_count: 0, items: [] }), false);
});

test("symbolHasNonDeclarationReference: a hit in another file is a reference", () => {
  assert.equal(
    symbolHasNonDeclarationReference("live", "src/export.ts", {
      total_count: 2,
      items: [
        { path: "src/export.ts", text_matches: [{ fragment: "export function live() {}" }] },
        { path: "src/use.ts", text_matches: [{ fragment: "import { live } from './export';" }] },
      ],
    }),
    true,
  );
});

test("symbolHasNonDeclarationReference: a lone declaration hit is not a reference", () => {
  assert.equal(
    symbolHasNonDeclarationReference("dead", "src/a.ts", {
      total_count: 1,
      items: [{ path: "src/a.ts", text_matches: [{ fragment: "export const dead = 1;" }] }],
    }),
    false,
  );
});

test("fragmentsLookLikeExportDeclaration: rejects use-site fragments", () => {
  assert.equal(fragmentsLookLikeExportDeclaration("live", ["import { live } from './a';"]), false);
  assert.equal(fragmentsLookLikeExportDeclaration("dead", ["export const dead = 1;"]), true);
});

test("scanUnusedExport: flags an unreferenced new export", async () => {
  const findings = await scanUnusedExport(
    req([{ path: "src/helpers.ts", patch: patchOf(["export const orphan = 42;"]) }]),
    searchResponse({ total_count: 1, items: [{ path: "src/helpers.ts", text_matches: [{ fragment: "export const orphan = 42;" }] }] }),
  );
  assert.deepEqual(findings, [{ file: "src/helpers.ts", line: 1, symbol: "orphan" }]);
});

test("scanUnusedExport: does not flag a referenced export", async () => {
  const findings = await scanUnusedExport(
    req([{ path: "src/helpers.ts", patch: patchOf(["export function shared() {}"]) }]),
    searchResponse({
      total_count: 2,
      items: [
        { path: "src/helpers.ts", text_matches: [{ fragment: "export function shared() {}" }] },
        { path: "src/worker.ts", text_matches: [{ fragment: "shared();" }] },
      ],
    }),
  );
  assert.deepEqual(findings, []);
});

test("scanUnusedExport: respects the search cap", async () => {
  let calls = 0;
  const countingFetch = async (url: string) => {
    if (String(url).includes("/search/code")) calls += 1;
    return new Response(JSON.stringify({ total_count: 0, items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const files = [
    { path: "src/a.ts", patch: patchOf(["export const a = 1;"]) },
    { path: "src/b.ts", patch: patchOf(["export const b = 2;"]) },
    { path: "src/c.ts", patch: patchOf(["export const c = 3;"]) },
  ];
  await scanUnusedExport(req(files), countingFetch, { maxSearches: 2 });
  assert.equal(calls, 2);
});

test("scanUnusedExport: skips when github token is absent", async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return new Response("", { status: 200 });
  };
  const findings = await scanUnusedExport(
    req([{ path: "src/a.ts", patch: patchOf(["export const x = 1;"]) }], { githubToken: undefined }),
    fetchFn,
  );
  assert.deepEqual(findings, []);
  assert.equal(called, false);
});

test("renderBrief: includes unusedExport findings via descriptor render", () => {
  const findings = [{ file: "src/a.ts", line: 2, symbol: "orphan" }];
  const brief = renderBrief({ unusedExport: findings }).promptSection;
  assert.match(brief, /Unused exports/i);
  assert.match(brief, /orphan/);
});

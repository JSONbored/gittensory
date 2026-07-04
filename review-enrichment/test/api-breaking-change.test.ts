// Units for the exported-API breaking-change analyzer (#1510). Own file so concurrent analyzer PRs don't collide.
// All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRemovedExports,
  scanApiBreakingChange,
} from "../dist/analyzers/api-breaking-change.js";
import { renderBrief } from "../dist/render.js";

// A patch that REMOVES an exported `oldApi` from the entrypoint (old-file lines 1-2 held it).
const REMOVE_PATCH = ["@@ -1,2 +1,1 @@", "-export function oldApi() {}", "-", "+export const kept = 1;"].join("\n");
const PKG_JSON = JSON.stringify({ name: "mypkg", version: "2.0.0", types: "index.d.ts" });
// The currently-published .d.ts surface still declares oldApi → removing it is a downstream break.
const PUBLISHED_DTS = ["export declare function oldApi(): void;", "export declare const kept: number;"].join("\n");

const rawResponse = (text) => new Response(text, { status: 200 });
// A fetch stub that answers each host with the supplied text; anything else 404s.
const stubFetch = ({ pkgJson = PKG_JSON, latest, dts = PUBLISHED_DTS } = {}) => {
  const latestJson = latest ?? JSON.stringify({ version: "2.0.0", types: "index.d.ts" });
  return async (url) => {
    if (url.includes("/contents/") && url.includes("package.json")) return rawResponse(pkgJson);
    if (url.startsWith("https://registry.npmjs.org/") && url.endsWith("/latest")) return rawResponse(latestJson);
    if (url.startsWith("https://unpkg.com/")) return rawResponse(dts);
    return new Response("", { status: 404 });
  };
};

const req = (files, extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  headSha: "abc123",
  files,
  ...extra,
});

test("parseRemovedExports: collects direct removed exports with old-file line numbers, ignores re-exports", () => {
  assert.deepEqual(parseRemovedExports(REMOVE_PATCH), [{ symbol: "oldApi", oldLine: 1 }]);
  // context/additions keep the old-line cursor aligned; `export { x }` / `export *` are not direct declarations
  const mixed = ["@@ -5,3 +5,1 @@", " const keep = 1;", "-export type Gone = string;", "-export { Gone };", "+x"].join("\n");
  assert.deepEqual(parseRemovedExports(mixed), [{ symbol: "Gone", oldLine: 6 }]);
});

test("scanApiBreakingChange: a removed published export → one 'removed' finding", async () => {
  const findings = await scanApiBreakingChange(
    req([{ path: "src/index.ts", status: "modified", patch: REMOVE_PATCH }]),
    stubFetch(),
  );
  assert.deepEqual(findings, [
    { file: "src/index.ts", symbol: "oldApi", change: "removed", packageName: "mypkg", publishedVersion: "2.0.0" },
  ]);
});

test("scanApiBreakingChange: a removed export NOT in the published surface → no finding", async () => {
  const findings = await scanApiBreakingChange(
    req([{ path: "src/index.ts", status: "modified", patch: REMOVE_PATCH }]),
    stubFetch({ dts: "export declare const kept: number;" }), // published surface no longer lists oldApi
  );
  assert.deepEqual(findings, []);
});

test("scanApiBreakingChange: a removed-and-readded UNCHANGED export → no finding", async () => {
  // oldApi is removed and re-added with an identical declaration body → not a break.
  const patch = ["@@ -1,1 +1,1 @@", "-export function oldApi() {}", "+export function oldApi() {}"].join("\n");
  const findings = await scanApiBreakingChange(
    req([{ path: "src/index.ts", status: "modified", patch }]),
    stubFetch(),
  );
  assert.deepEqual(findings, []);
});

test("scanApiBreakingChange: a signature-changed published export → 'signature-changed' finding", async () => {
  // oldApi is removed and re-added with a CHANGED declaration body → a signature change.
  const patch = ["@@ -1,1 +1,1 @@", "-export function oldApi() {}", "+export function oldApi(x: number): void {}"].join("\n");
  const findings = await scanApiBreakingChange(
    req([{ path: "src/index.ts", status: "modified", patch }]),
    stubFetch(),
  );
  assert.deepEqual(findings, [
    { file: "src/index.ts", symbol: "oldApi", change: "signature-changed", packageName: "mypkg", publishedVersion: "2.0.0" },
  ]);
});

test("scanApiBreakingChange: a .d.ts entrypoint is scanned and the package walk resolves an ancestor package.json", async () => {
  // Removing a published symbol from a nested declaration file; package.json lives at the package root (2 levels up).
  const patch = ["@@ -1,1 +1,0 @@", "-export declare function oldApi(): void;"].join("\n");
  let manifestUrl = "";
  const recording = async (url) => {
    if (url.includes("/contents/") && url.includes("package.json")) {
      manifestUrl = url;
      // only the package-root manifest exists; the nested dir has none
      return url.includes("packages/foo/package.json") ? rawResponse(PKG_JSON) : new Response("", { status: 404 });
    }
    if (url.startsWith("https://registry.npmjs.org/") && url.endsWith("/latest")) {
      return rawResponse(JSON.stringify({ version: "2.0.0", types: "index.d.ts" }));
    }
    if (url.startsWith("https://unpkg.com/")) return rawResponse(PUBLISHED_DTS);
    return new Response("", { status: 404 });
  };
  const findings = await scanApiBreakingChange(
    req([{ path: "packages/foo/dts/api.d.ts", status: "modified", patch }]),
    recording,
  );
  assert.deepEqual(findings, [
    { file: "packages/foo/dts/api.d.ts", symbol: "oldApi", change: "removed", packageName: "mypkg", publishedVersion: "2.0.0" },
  ]);
  assert.match(manifestUrl, /packages\/foo\/package\.json\?ref=abc123$/);
});

test("scanApiBreakingChange: missing token or headSha → [] (no finding, no throw)", async () => {
  const files = [{ path: "src/index.ts", status: "modified", patch: REMOVE_PATCH }];
  assert.deepEqual(await scanApiBreakingChange(req(files, { githubToken: undefined }), stubFetch()), []);
  assert.deepEqual(await scanApiBreakingChange(req(files, { headSha: undefined }), stubFetch()), []);
});

test("scanApiBreakingChange: a non-entrypoint / test file is skipped", async () => {
  assert.deepEqual(
    await scanApiBreakingChange(req([{ path: "src/helpers.ts", status: "modified", patch: REMOVE_PATCH }]), stubFetch()),
    [],
  );
  assert.deepEqual(
    await scanApiBreakingChange(req([{ path: "src/index.test.ts", status: "modified", patch: REMOVE_PATCH }]), stubFetch()),
    [],
  );
});

test("scanApiBreakingChange: a fetch error (or a package.json that never resolves) yields no finding (fail-safe)", async () => {
  const files = [{ path: "src/index.ts", status: "modified", patch: REMOVE_PATCH }];
  const rejecting = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await scanApiBreakingChange(req(files), rejecting), []);
  const allNotFound = async () => new Response("", { status: 404 });
  assert.deepEqual(await scanApiBreakingChange(req(files), allNotFound), []);
});

test("scanApiBreakingChange: renders a header + a bullet; empty findings render nothing", async () => {
  const findings = await scanApiBreakingChange(
    req([{ path: "src/index.ts", status: "modified", patch: REMOVE_PATCH }]),
    stubFetch(),
  );
  const brief = renderBrief({ apiBreakingChange: findings }).promptSection;
  assert.match(brief, /Exported-API breaking changes/);
  assert.match(brief, /mypkg@2\.0\.0/);
  assert.match(brief, /oldApi/);
  // empty findings → no section at all
  assert.equal(renderBrief({ apiBreakingChange: [] }).promptSection, "");
});

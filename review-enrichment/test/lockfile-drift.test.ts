import { test } from "node:test";
import assert from "node:assert/strict";

import { extractLockfileChanges, queryOsvBatch, scanLockfileDrift } from "../dist/analyzers/lockfile-drift.js";

test("extractLockfileChanges matches lockfile basenames case-insensitively", () => {
  const changes = extractLockfileChanges([
    {
      path: "frontend/Yarn.lock",
      patch: [
        "@@ -1,0 +1,2 @@",
        "+lodash@^4.17.21:",
        '+  version "4.17.21"',
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, [
    {
      file: "frontend/Yarn.lock",
      line: 2,
      ecosystem: "npm",
      package: "lodash",
      from: null,
      to: "4.17.21",
    },
  ]);
});

test("extractLockfileChanges keeps new-file line numbers correct across ++-content added lines", () => {
  // An added line whose CONTENT begins with `++ ` renders in the diff as `+++ …`. The old anchored
  // `startsWith("+++ ")` guard mistook it for a `+++ b/file` header and `continue`d WITHOUT advancing the
  // new-file line counter, so every finding AFTER it was reported one line too low. The shared
  // isDiffFileHeaderLine helper only skips real `+++ a/`/`b/`/`/dev/null` headers, so the counter stays true.
  const changes = extractLockfileChanges([
    {
      path: "package-lock.json",
      patch: [
        "@@ -9,0 +10,3 @@",
        '+    "node_modules/lodash": {', // new-file line 10
        "+++ not a header — added content whose text begins with ++", // new-file line 11 (must be counted)
        '+      "version": "4.17.21"', // new-file line 12
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, [
    {
      file: "package-lock.json",
      line: 12, // 12, not 11 — the intervening ++-content line is counted, not swallowed as a header
      ecosystem: "npm",
      package: "lodash",
      from: null,
      to: "4.17.21",
    },
  ]);
});

test("extractLockfileChanges does not let unparsed lockfiles consume the scan budget", () => {
  const yarnPatch = [
    "@@ -1,0 +1,2 @@",
    "+lodash@^4.17.21:",
    '+  version "4.17.21"',
  ].join("\n");
  const filler = Array.from({ length: 12 }, (_, index) => ({
    path: `pkg-${index}/pnpm-lock.yaml`,
    patch: "@@ -1,0 +1,1 @@\n+lockfileVersion: 6.0",
  }));

  const changes = extractLockfileChanges([
    ...filler,
    { path: "frontend/Yarn.lock", patch: yarnPatch },
  ]);

  assert.deepEqual(changes, [
    {
      file: "frontend/Yarn.lock",
      line: 2,
      ecosystem: "npm",
      package: "lodash",
      from: null,
      to: "4.17.21",
    },
  ]);
});

test("extractLockfileChanges excludes PyPI direct deps under PEP 503 name normalization", () => {
  // Manifests often use `Django` / `PyYAML` while poetry.lock stores `django` / `pyyaml`.
  // Without PEP 503 normalization those were treated as lockfile-only transitive drift.
  const changes = extractLockfileChanges([
    {
      path: "requirements.txt",
      patch: ["@@ -1,0 +1,2 @@", "+Django==4.2.0", "+PyYAML==6.0"].join("\n"),
    },
    {
      path: "poetry.lock",
      patch: [
        "@@ -1,0 +1,6 @@",
        "+[[package]]",
        '+name = "django"',
        '+version = "4.2.0"',
        "+[[package]]",
        '+name = "pyyaml"',
        '+version = "6.0"',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(changes, []);
});

test("extractLockfileChanges still reports a PyPI lockfile-only package", () => {
  // A package present only in poetry.lock (no manifest entry) remains lockfile drift.
  const changes = extractLockfileChanges([
    {
      path: "poetry.lock",
      patch: [
        "@@ -1,0 +1,3 @@",
        "+[[package]]",
        '+name = "requests"',
        '+version = "2.31.0"',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(changes, [
    {
      file: "poetry.lock",
      line: 3,
      ecosystem: "PyPI",
      package: "requests",
      from: null,
      to: "2.31.0",
    },
  ]);
});

test("extractLockfileChanges reports an upgraded resolved version (from -> to) in each supported lockfile format", () => {
  // The existing cases above only exercise ADDED entries (from: null). An upgrade renders as a `-` old
  // version plus a `+` new version under a CONTEXT package header — the header itself is unchanged.
  const changes = extractLockfileChanges([
    {
      path: "package-lock.json",
      patch: [
        "@@ -10,2 +10,2 @@",
        '     "node_modules/lodash": {',
        '-      "version": "4.17.20",',
        '+      "version": "4.17.21",',
      ].join("\n"),
    },
    {
      path: "yarn.lock",
      patch: [
        "@@ -5,2 +5,2 @@",
        " axios@^1.6.0:",
        '-  version "1.6.0"',
        '+  version "1.6.1"',
      ].join("\n"),
    },
    {
      path: "poetry.lock",
      patch: [
        "@@ -1,3 +1,3 @@",
        " [[package]]",
        ' name = "requests"',
        '-version = "2.31.0"',
        '+version = "2.32.0"',
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, [
    { file: "package-lock.json", line: 11, ecosystem: "npm", package: "lodash", from: "4.17.20", to: "4.17.21" },
    { file: "yarn.lock", line: 6, ecosystem: "npm", package: "axios", from: "1.6.0", to: "1.6.1" },
    { file: "poetry.lock", line: 3, ecosystem: "PyPI", package: "requests", from: "2.31.0", to: "2.32.0" },
  ]);
});

test("extractLockfileChanges resolves a scoped npm package from a multi-descriptor yarn header, deduped", () => {
  const changes = extractLockfileChanges([
    {
      path: "yarn.lock",
      patch: [
        "@@ -1,0 +1,2 @@",
        '+"@babel/core@^7.0.0", "@babel/core@^7.1.0":',
        '+  version "7.2.0"',
      ].join("\n"),
    },
  ]);

  // Both descriptors name the same scoped package — one change, not two.
  assert.deepEqual(changes, [
    { file: "yarn.lock", line: 2, ecosystem: "npm", package: "@babel/core", from: null, to: "7.2.0" },
  ]);
});

test("extractLockfileChanges: removed-only and unchanged lockfile entries produce no drift", () => {
  const changes = extractLockfileChanges([
    {
      // Removed-only: the package leaves the lockfile — there is no new resolved version to query.
      path: "package-lock.json",
      patch: [
        "@@ -10,2 +10,1 @@",
        '     "node_modules/lodash": {',
        '-      "version": "4.17.20",',
      ].join("\n"),
    },
    {
      // Same-version rewrite (formatting churn): from === to is not drift.
      path: "yarn.lock",
      patch: [
        "@@ -5,2 +5,2 @@",
        " axios@^1.6.0:",
        '-  version "1.6.1"',
        '+  version "1.6.1"',
      ].join("\n"),
    },
    {
      // Purely-context hunk: nothing added or removed at all.
      path: "poetry.lock",
      patch: [
        "@@ -1,3 +1,3 @@",
        " [[package]]",
        ' name = "requests"',
        ' version = "2.31.0"',
      ].join("\n"),
    },
  ]);

  assert.deepEqual(changes, []);
});

test("extractLockfileChanges skips malformed/partial lockfile hunks rather than throwing", () => {
  // A version line with no preceding package header (a truncated hunk) has no package to attribute the
  // version to — in every format it must be dropped, and never throw.
  const changes = extractLockfileChanges([
    {
      path: "package-lock.json",
      patch: [
        "@@ -1,0 +1,2 @@",
        '+      "version": "4.17.21",',
        "+  garbage { not json",
      ].join("\n"),
    },
    {
      path: "yarn.lock",
      patch: ["@@ -1,0 +1,1 @@", '+  version "1.0.0"'].join("\n"),
    },
    {
      path: "poetry.lock",
      patch: ["@@ -1,0 +1,2 @@", '+version = "1.0"', "+[[package]]"].join("\n"),
    },
  ]);

  assert.deepEqual(changes, []);
});

// #7009: queryOsvBatch used to `if (!response.ok) continue;` on a batch-endpoint failure, silently dropping
// every change in that chunk — unlike dependency-scan.ts, which degrades to per-item /v1/query calls. These
// pin the added fallback: a batch hiccup must produce slower-but-complete per-item results, never a lost chunk.

/** A minimal OSV `Response` the bounded fetch reader accepts: no content-length, no stream body, so it reads
 *  via `text()`. Mirrors how api.osv.dev replies to a single or batch query. */
function osvResponse(payload: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(payload) };
}
function osvFailure(status = 503) {
  return { ok: false, status, headers: { get: () => null } };
}
const lockChange = (pkg: string, to: string) =>
  ({ file: "package-lock.json", line: 1, ecosystem: "npm" as const, package: pkg, from: null, to });

test("queryOsvBatch: a successful batch maps each change's vulns and never falls back to per-item queries", async () => {
  let perItemCalls = 0;
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/query")) perItemCalls += 1;
    return osvResponse({ results: [{ vulns: [{ id: "OSV-batch" }] }, { vulns: [] }] });
  }) as unknown as typeof fetch;
  const result = await queryOsvBatch([lockChange("lodash", "4.17.21"), lockChange("leftpad", "1.0.1")], fetchImpl);
  assert.deepEqual(result.get("npm::lodash@4.17.21")?.map((c) => c.id), ["OSV-batch"]);
  assert.deepEqual(result.get("npm::leftpad@1.0.1"), []);
  assert.equal(perItemCalls, 0);
});

test("queryOsvBatch: on a batch-endpoint failure, falls back to per-item OSV queries instead of dropping the chunk", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    urls.push(url);
    if (url.endsWith("/v1/querybatch")) return osvFailure(503);
    const name = (JSON.parse(init.body) as { package: { name: string } }).package.name;
    return osvResponse({ vulns: name === "lodash" ? [{ id: "OSV-lodash", summary: "prototype pollution" }] : [] });
  }) as unknown as typeof fetch;
  const result = await queryOsvBatch([lockChange("lodash", "4.17.21"), lockChange("leftpad", "1.0.1")], fetchImpl);
  // the failed batch degraded to per-item queries — the vulnerable package's CVE survives...
  assert.deepEqual(result.get("npm::lodash@4.17.21")?.map((c) => c.id), ["OSV-lodash"]);
  // ...and the clean package is still recorded (empty, not silently missing)
  assert.deepEqual(result.get("npm::leftpad@1.0.1"), []);
  assert.ok(urls.some((u) => u.endsWith("/v1/querybatch")));
  assert.equal(urls.filter((u) => u.endsWith("/v1/query")).length, 2);
});

test("queryOsvBatch: a per-item fallback that also fails records an empty result rather than omitting the change", async () => {
  const fetchImpl = (async (url: string) => (url.endsWith("/v1/querybatch") ? osvFailure(503) : osvFailure(500))) as unknown as typeof fetch;
  const result = await queryOsvBatch([lockChange("lodash", "4.17.21")], fetchImpl);
  assert.ok(result.has("npm::lodash@4.17.21"));
  assert.deepEqual(result.get("npm::lodash@4.17.21"), []);
});

test("queryOsvBatch: the per-item fallback routes through an injected AnalysisContext when one is supplied", async () => {
  const seen: string[] = [];
  const analysis = {
    fetchJson: async (url: string, init: { body: string }) => {
      seen.push(url);
      if (url.endsWith("/v1/querybatch")) return { ok: false, status: 503 };
      const name = (JSON.parse(init.body) as { package: { name: string } }).package.name;
      return { ok: true, status: 200, data: { vulns: name === "lodash" ? [{ id: "OSV-ctx" }] : [] } };
    },
  };
  const noDirectFetch = (async () => {
    throw new Error("analysis context supplied — the raw fetchImpl must not be used");
  }) as unknown as typeof fetch;
  const result = await queryOsvBatch([lockChange("lodash", "4.17.21")], noDirectFetch, undefined, {
    analysis: analysis as never,
  });
  assert.deepEqual(result.get("npm::lodash@4.17.21")?.map((c) => c.id), ["OSV-ctx"]);
  assert.ok(seen.some((u) => u.endsWith("/v1/query")));
});

test("queryOsvBatch: a mid-batch abort short-circuits the per-item fallback to empty results", async () => {
  const controller = new AbortController();
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/v1/querybatch")) {
      controller.abort();
      return osvFailure(503);
    }
    throw new Error("per-item query must not run once the signal is aborted");
  }) as unknown as typeof fetch;
  const result = await queryOsvBatch([lockChange("lodash", "4.17.21")], fetchImpl, controller.signal);
  assert.deepEqual(result.get("npm::lodash@4.17.21"), []);
});

test("scanLockfileDrift: a batch-API failure still surfaces a per-item CVE finding for a vulnerable lockfile bump", async () => {
  const fetchImpl = (async (url: string, init: { body: string }) => {
    if (url.endsWith("/v1/querybatch")) return osvFailure(503);
    const name = (JSON.parse(init.body) as { package: { name: string } }).package.name;
    return osvResponse({ vulns: name === "lodash" ? [{ id: "OSV-lodash", summary: "prototype pollution" }] : [] });
  }) as unknown as typeof fetch;
  const findings = await scanLockfileDrift(
    {
      files: [
        {
          path: "package-lock.json",
          patch: ['@@ -9,0 +10,2 @@', '+    "node_modules/lodash": {', '+      "version": "4.17.21"'].join("\n"),
        },
      ],
    } as Parameters<typeof scanLockfileDrift>[0],
    fetchImpl,
  );
  // end-to-end: the transient batch failure degraded to a per-item query, so the vulnerable bump is still reported.
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.package, "lodash");
  assert.deepEqual(findings[0]?.cves.map((c) => c.id), ["OSV-lodash"]);
});

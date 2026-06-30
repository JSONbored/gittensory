// Units for cross-file caller-impact / dead-symbol analyzer (#1509). Kept standalone so it can evolve
// without bloating enrichment.test.ts. All HTTP is mocked; no external network dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanCallerImpact } from "../dist/analyzers/caller-impact.js";
import { renderBrief } from "../dist/render.js";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const textResponse = (text, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => text,
});

const req = (patches) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  headSha: "abc123",
  githubToken: "ghp_testtoken",
  files: patches,
});

const expectSearch = (items) =>
  async (url) => {
    if (url.includes("/search/code")) {
      return jsonResponse({ items });
    }
    throw new Error(`unexpected request: ${url}`);
  };

const fileContentsRouter = (contents) =>
  async (url) => {
    for (const [path, text] of contents) {
      if (url.includes(path)) return textResponse(text);
    }
    return undefined;
  };

const fetchFor = (...handlers) => {
  const [searchHandler, ...contentHandlers] = handlers;
  return async (url) => {
    if (url.includes("/search/code")) {
      return searchHandler(url);
    }
    for (const handler of contentHandlers) {
      const out = await handler(url);
      if (out) return out;
    }
    throw new Error(`unhandled request: ${url}`);
  };
};

test("scanCallerImpact: changed export flags unchanged callers", async () => {
  const findings = await scanCallerImpact(
    req([
      {
        path: "src/api.ts",
        patch:
          "@@ -1,2 +1,2 @@\n-export function doThing(a: number) {}\n+export function doThing(a: string) {}",
      },
    ]),
    fetchFor(
      expectSearch([
        { path: "src/consumer.ts" },
        { path: "src/api.ts" },
      ]),
      fileContentsRouter([
        ["/contents/src/api.ts?ref=abc123", "export function doThing(a: string) {}"],
        ["/contents/src/consumer.ts?ref=abc123", "import { doThing } from './api';\ndoThing('x');"],
      ]),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "changed");
  assert.equal(findings[0].symbol, "doThing");
  assert.deepEqual(findings[0].callers, ["src/consumer.ts"]);
});

test("scanCallerImpact: handles symbol boundaries for dollar-prefixed identifiers", async () => {
  const findings = await scanCallerImpact(
    req([
      {
        path: "src/api.ts",
        patch:
          "@@ -1,2 +1,2 @@\n-export function $api(a: number) {}\n+export function $api(a: string) {}",
      },
    ]),
    fetchFor(
      expectSearch([{ path: "src/consumer.ts" }]),
      fileContentsRouter([
        ["/contents/src/api.ts?ref=abc123", "export function $api(a: string) {}"],
        [
          "/contents/src/consumer.ts?ref=abc123",
          "import { $api } from './api';\n$api('x');\n",
        ],
      ]),
    ),
  );

  assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "changed");
    assert.equal(findings[0].symbol, "$api");
    assert.deepEqual(findings[0].callers, ["src/consumer.ts"]);
});

test("scanCallerImpact: handles symbol boundaries for dollar-suffixed identifiers", async () => {
  const findings = await scanCallerImpact(
    req([
      {
        path: "src/api.ts",
        patch:
          "@@ -1,1 +1,1 @@\n-export function api$(a: string) {}\n+export function api$(a: number) {}",
      },
    ]),
    fetchFor(
      expectSearch([{ path: "src/consumer.ts" }]),
      fileContentsRouter([
        ["/contents/src/api.ts?ref=abc123", "export function api$(a: number) {}"],
        [
          "/contents/src/consumer.ts?ref=abc123",
          "import { api$ } from './api';\napi$('x');\n",
        ],
      ]),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "changed");
  assert.equal(findings[0].symbol, "api$");
  assert.deepEqual(findings[0].callers, ["src/consumer.ts"]);
});

test("scanCallerImpact: removed export flags live callsites", async () => {
  const findings = await scanCallerImpact(
    req([
      {
        path: "src/api.ts",
        patch: "@@ -1,1 +1,0 @@\n-export function removedFeature() {}",
      },
    ]),
    fetchFor(
      expectSearch([{ path: "src/consumer.ts" }]),
      fileContentsRouter([
        ["/contents/src/consumer.ts?ref=abc123", "removedFeature();"],
      ]),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "removed");
  assert.equal(findings[0].symbol, "removedFeature");
  assert.deepEqual(findings[0].callers, ["src/consumer.ts"]);
});

test("scanCallerImpact: renamed export reports old symbol still referenced", async () => {
  const findings = await scanCallerImpact(
    req([
      {
        path: "src/api.ts",
        patch:
          "@@ -1,1 +1,1 @@\n-export { oldName as OldFeature };\n+export { oldName as NewFeature };",
      },
    ]),
    fetchFor(
      expectSearch([{ path: "src/consumer.ts" }]),
      fileContentsRouter([
        ["/contents/src/consumer.ts?ref=abc123", "import { OldFeature } from './api';\nOldFeature();"],
      ]),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "renamed");
  assert.equal(findings[0].previousSymbol, "OldFeature");
  assert.equal(findings[0].symbol, "NewFeature");
  assert.deepEqual(findings[0].callers, ["src/consumer.ts"]);
});

test("scanCallerImpact: dead new export is reported without unchanged callers", async () => {
  const findings = await scanCallerImpact(
    req([
      {
        path: "src/api.ts",
        patch:
          "@@ -1,0 +1,1 @@\n+export function deadApi() { return 7; }",
      },
    ]),
    fetchFor(
      expectSearch([{ path: "src/consumer.ts" }]),
      fileContentsRouter([
        ["/contents/src/consumer.ts?ref=abc123", "export const x = 1;"],
      ]),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "dead");
  assert.equal(findings[0].symbol, "deadApi");
  assert.deepEqual(findings[0].callers, []);
});

test("scanCallerImpact: import-only references are still live callers", async () => {
  const findings = await scanCallerImpact(
    req([
      {
        path: "src/api.ts",
        patch:
          "@@ -1,1 +1,1 @@\n-export function doThing(a: number) {}\n+export function doThing(a: string) {}",
      },
    ]),
    fetchFor(
      expectSearch([{ path: "src/consumer.ts" }]),
      fileContentsRouter([
        ["/contents/src/api.ts?ref=abc123", "export function doThing(a: string) {}"],
        [
          "/contents/src/consumer.ts?ref=abc123",
          "import { doThing } from './api';",
        ],
      ]),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "changed");
  assert.equal(findings[0].symbol, "doThing");
  assert.deepEqual(findings[0].callers, ["src/consumer.ts"]);
});

test("scanCallerImpact: dead detection ignores changed-file callsites", async () => {
  const findings = await scanCallerImpact(
    req([
      {
        path: "src/api.ts",
        patch:
          "@@ -1,0 +1,2 @@\n+export function localEntry() { return 1; }\n+localEntry();",
      },
    ]),
    fetchFor(
      expectSearch([{ path: "src/api.ts" }]),
      fileContentsRouter([
        ["/contents/src/api.ts?ref=abc123", "export function localEntry() { return 1; }\nlocalEntry();"],
      ]),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "dead");
  assert.equal(findings[0].symbol, "localEntry");
  assert.deepEqual(findings[0].callers, []);
});

test("scanCallerImpact: missing token/head-sha skips analysis", async () => {
  const outNoToken = await scanCallerImpact({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [{ path: "src/api.ts", patch: "+export function x() {}" }],
    headSha: "abc123",
  } as never);
  assert.deepEqual(outNoToken, []);

  const outNoHead = await scanCallerImpact({
    repoFullName: "octo/repo",
    prNumber: 1,
    githubToken: "ghp_testtoken",
    files: [{ path: "src/api.ts", patch: "+export function x() {}" }],
  } as never);
  assert.deepEqual(outNoHead, []);
});

test("renderBrief includes caller-impact findings", () => {
  const { promptSection } = renderBrief({
    callerImpact: [
      {
        kind: "renamed",
        file: "src/api.ts",
        line: 12,
        symbol: "NewFeature",
        searchSymbol: "OldFeature",
        previousSymbol: "OldFeature",
        callers: ["src/consumer.ts", "src/widgets.ts"],
      },
      {
        kind: "dead",
        file: "src/api.ts",
        line: 27,
        symbol: "deadApi",
        searchSymbol: "deadApi",
        callers: [],
      },
    ],
  } as never);

  assert.match(promptSection, /Export caller-impact and dead-symbol candidates/);
  assert.match(promptSection, /OldFeature/);
  assert.match(promptSection, /NewFeature/);
  assert.match(promptSection, /deadApi/);
});

// Units for the maintenance-health / deprecated-dep analyzer (#1511). Own file (not enrichment.test.ts) so
// concurrent analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newestNpmPublishMs,
  newestPypiUploadMs,
  npmHealth,
  pypiHealth,
  pep440Key,
  resolvePypiReleaseKey,
  scanDepMaintenanceHealth,
} from "../dist/analyzers/dep-maintenance-health.js";
import { renderBrief } from "../dist/render.js";

const NOW = Date.parse("2026-06-29T00:00:00Z");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const STALE_MS = 2 * YEAR_MS;
const iso = (ms) => new Date(ms).toISOString();

// A package.json diff that ADDS one dependency (a single `+` line → from === null).
const npmAdd = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "${name}": "^${version}"` }],
});
const pypiAdd = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "requirements.txt", patch: `@@ -1,0 +1,1 @@\n+${name}==${version}` }],
});
// Real Response objects so the bounded reader (headers + body stream) works exactly as in production.
const jsonResponse = (body, init) => new Response(JSON.stringify(body), init);
const npmFetch = (packument) => async () => jsonResponse(packument);
const pypiFetch = (data) => async () => jsonResponse(data);
const status = (code) => async () => jsonResponse({}, { status: code });
const throwingFetch = async () => {
  throw new Error("network down");
};
const freshNpmTime = { "1.0.0": iso(NOW - 30 * 24 * 60 * 60 * 1000) };
const freshPypiReleases = { "1.0.0": [{ upload_time_iso_8601: iso(NOW - 30 * 24 * 60 * 60 * 1000) }] };

test("npmHealth: a non-empty deprecated STRING on the queried version is flagged with its reason", () => {
  const hit = npmHealth({ versions: { "1.0.0": { deprecated: "use foo instead" } }, time: freshNpmTime }, "1.0.0", STALE_MS, NOW);
  assert.equal(hit?.kind, "deprecated");
  assert.match(hit.reason, /use foo instead/);
});

test("npmHealth: a top-level deprecated STRING is accepted as a fallback (incl. when version-level is empty)", () => {
  assert.match(npmHealth({ deprecated: "gone", time: freshNpmTime }, "1.0.0", STALE_MS, NOW).reason, /gone/);
  // version-level present but empty ⇒ falls back to the top-level reason (documents the precedence).
  const hit = npmHealth({ versions: { "1.0.0": { deprecated: "" } }, deprecated: "top reason", time: freshNpmTime }, "1.0.0", STALE_MS, NOW);
  assert.equal(hit?.kind, "deprecated");
  assert.match(hit.reason, /top reason/);
});

test("npmHealth: deprecation on a DIFFERENT version is not attributed to the queried version", () => {
  assert.equal(npmHealth({ versions: { "0.9.0": { deprecated: "old" } }, time: freshNpmTime }, "1.0.0", STALE_MS, NOW), null);
});

test("npmHealth: deprecated false/boolean/empty/whitespace is NOT a deprecation (fail safe)", () => {
  assert.equal(npmHealth({ versions: { "1.0.0": { deprecated: false } }, time: freshNpmTime }, "1.0.0", STALE_MS, NOW), null);
  assert.equal(npmHealth({ versions: { "1.0.0": { deprecated: true } }, time: freshNpmTime }, "1.0.0", STALE_MS, NOW), null);
  assert.equal(npmHealth({ versions: { "1.0.0": { deprecated: "" } }, time: freshNpmTime }, "1.0.0", STALE_MS, NOW), null);
  assert.equal(npmHealth({ deprecated: "   ", time: freshNpmTime }, "1.0.0", STALE_MS, NOW), null);
});

test("npmHealth: a package with no release in >2y is flagged stale", () => {
  const hit = npmHealth({ time: { "1.0.0": iso(NOW - 3 * YEAR_MS) } }, "1.0.0", STALE_MS, NOW);
  assert.equal(hit?.kind, "stale");
  assert.match(hit.reason, /no release in ~3y/);
});

test("npmHealth: a recently-published healthy package yields no finding", () => {
  assert.equal(npmHealth({ time: freshNpmTime }, "1.0.0", STALE_MS, NOW), null);
});

test("npmHealth: missing time / no parseable date fails safe (no stale finding)", () => {
  assert.equal(npmHealth({}, "1.0.0", STALE_MS, NOW), null);
  assert.equal(npmHealth({ time: { "1.0.0": "not-a-date" } }, "1.0.0", STALE_MS, NOW), null);
});

test("newestNpmPublishMs: ignores created/modified and unparseable timestamps", () => {
  const ms = newestNpmPublishMs({
    created: iso(NOW),
    modified: iso(NOW),
    "1.0.0": iso(NOW - 5 * YEAR_MS),
    "1.1.0": "garbage",
    "2.0.0": iso(NOW - 3 * YEAR_MS),
  });
  assert.equal(ms, NOW - 3 * YEAR_MS); // newest real publish, not the created/modified pseudo-entries
});

test("pep440Key: trailing-zero-insignificant and separator-normalized versions compare equal", () => {
  assert.equal(pep440Key("1.0.0"), pep440Key("1.0"));
  assert.equal(pep440Key("1.0.0"), pep440Key("1"));
  assert.equal(pep440Key("1.0-rc1"), pep440Key("1.0rc1"));
  assert.equal(pep440Key("1.0.rc1"), pep440Key("1.0rc1")); // dotted separator too
  assert.equal(pep440Key("1.0c1"), pep440Key("1.0rc1")); // c is an alias for rc
  assert.equal(pep440Key("1.0-1"), pep440Key("1.0.post1")); // implicit post release
  assert.equal(pep440Key("V1.0.0+local"), pep440Key("1.0")); // leading v + local segment ignored
  assert.notEqual(pep440Key("1.10"), pep440Key("1.1")); // distinct versions stay distinct
  assert.notEqual(pep440Key("1!2.0"), pep440Key("2.0")); // epoch is significant
  assert.equal(pep440Key("not-a-version"), null);
});

test("pep440Key: rejects malformed numeric-prefix versions (arbitrary suffix) instead of normalizing them", () => {
  // The blocker case: `1.0foo` must NOT collide with a release keyed `1.0.foo`; both are invalid → null.
  assert.equal(pep440Key("1.0foo"), null);
  assert.equal(pep440Key("1.0.foo"), null);
  assert.equal(pep440Key("1.0rc"), "0!1rc0"); // a real pre-release with implicit number IS valid
});

test("resolvePypiReleaseKey: an invalid requested version never false-matches a release key", () => {
  assert.equal(resolvePypiReleaseKey({ "1.0.foo": [] }, "1.0foo"), null);
});

test("resolvePypiReleaseKey: exact match first, then PEP 440 equality, else null", () => {
  assert.equal(resolvePypiReleaseKey({ "1.0.0": [] }, "1.0.0"), "1.0.0");
  assert.equal(resolvePypiReleaseKey({ "1.0": [] }, "1.0.0"), "1.0"); // ==1.0.0 resolves to release 1.0
  assert.equal(resolvePypiReleaseKey({ "2.0": [] }, "1.0.0"), null);
  assert.equal(resolvePypiReleaseKey(undefined, "1.0.0"), null);
});

test("pypiHealth: a yanked version is flagged even when its release key is a PEP 440 equivalent", () => {
  // requirement ==1.0.0, but PyPI keys the release as 1.0 — must still resolve and flag yanked.
  const hit = pypiHealth(
    { releases: { "1.0": [{ upload_time_iso_8601: iso(NOW), yanked: true, yanked_reason: "security issue" }] } },
    "1.0.0",
    STALE_MS,
    NOW,
  );
  assert.equal(hit?.kind, "yanked");
  assert.match(hit.reason, /security issue/);
});

test("pypiHealth: a yanked version with no/null reason still flags (no reason appended)", () => {
  const hit = pypiHealth({ releases: { "1.0.0": [{ upload_time_iso_8601: iso(NOW), yanked: true, yanked_reason: null }] } }, "1.0.0", STALE_MS, NOW);
  assert.equal(hit?.kind, "yanked");
  assert.match(hit.reason, /release yanked from PyPI$/);
});

test("pypiHealth: yanked is read for the QUERIED version only (a different yanked version is ignored)", () => {
  const data = {
    releases: {
      "1.0.0": [{ upload_time_iso_8601: iso(NOW), yanked: true }],
      "2.0.0": [{ upload_time_iso_8601: iso(NOW) }],
    },
  };
  assert.equal(pypiHealth(data, "2.0.0", STALE_MS, NOW), null);
});

test("pypiHealth: a partially-yanked version (some files not yanked) / no files is not flagged yanked", () => {
  const partial = {
    releases: { "1.0.0": [{ upload_time_iso_8601: iso(NOW), yanked: true }, { upload_time_iso_8601: iso(NOW), yanked: false }] },
  };
  assert.notEqual(pypiHealth(partial, "1.0.0", STALE_MS, NOW)?.kind, "yanked");
  assert.equal(pypiHealth({ releases: freshPypiReleases }, "1.0.0", STALE_MS, NOW), null);
});

test("pypiHealth: no upload in >2y is flagged stale; falls back to upload_time", () => {
  const hit = pypiHealth({ releases: { "1.0.0": [{ upload_time: iso(NOW - 4 * YEAR_MS) }] } }, "1.0.0", STALE_MS, NOW);
  assert.equal(hit?.kind, "stale");
  assert.match(hit.reason, /no release in ~4y/);
});

test("pypiHealth: missing releases / unparseable upload date fails safe", () => {
  assert.equal(pypiHealth({}, "1.0.0", STALE_MS, NOW), null);
  assert.equal(pypiHealth({ releases: { "1.0.0": [{ upload_time_iso_8601: "nope" }] } }, "1.0.0", STALE_MS, NOW), null);
});

test("pypiHealth / newestPypiUploadMs: malformed (non-array / null / non-object) release values fail safe, never throw", () => {
  assert.equal(newestPypiUploadMs({ "1.0.0": {} }), null);
  assert.equal(newestPypiUploadMs({ "1.0.0": null }), null);
  assert.equal(newestPypiUploadMs({ "1.0.0": [null, "x", 7] }), null);
  assert.doesNotThrow(() => pypiHealth({ releases: { "1.0.0": {} } }, "1.0.0", STALE_MS, NOW));
  assert.equal(pypiHealth({ releases: { "1.0.0": {} } }, "1.0.0", STALE_MS, NOW), null);
  assert.doesNotThrow(() => pypiHealth({ releases: { "1.0.0": [null] } }, "1.0.0", STALE_MS, NOW));
  assert.equal(pypiHealth({ releases: { "1.0.0": [null, "x"] } }, "1.0.0", STALE_MS, NOW), null);
});

test("newestPypiUploadMs: handles missing/empty file lists and picks the newest", () => {
  assert.equal(newestPypiUploadMs(undefined), null);
  assert.equal(newestPypiUploadMs({ "1.0.0": [] }), null);
  const ms = newestPypiUploadMs({
    "1.0.0": [{ upload_time_iso_8601: iso(NOW - 5 * YEAR_MS) }],
    "2.0.0": [{ upload_time_iso_8601: iso(NOW - 1 * YEAR_MS) }],
  });
  assert.equal(ms, NOW - 1 * YEAR_MS);
});

test("scanDepMaintenanceHealth: npm deprecated dependency is flagged", async () => {
  const findings = await scanDepMaintenanceHealth(
    npmAdd("request"),
    npmFetch({ deprecated: "no longer supported", time: freshNpmTime }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "deprecated");
  assert.equal(findings[0].ecosystem, "npm");
  assert.equal(findings[0].package, "request");
  assert.equal(findings[0].version, "1.0.0");
});

test("scanDepMaintenanceHealth: a PyPI yanked release is matched by PEP 440 equality (==1.0.0 → release 1.0)", async () => {
  const findings = await scanDepMaintenanceHealth(
    pypiAdd("badpkg", "1.0.0"),
    pypiFetch({ releases: { "1.0": [{ upload_time_iso_8601: iso(NOW), yanked: true, yanked_reason: "broken" }] } }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "yanked");
  assert.equal(findings[0].ecosystem, "PyPI");
  assert.equal(findings[0].version, "1.0.0"); // reports the requirement's version
});

test("scanDepMaintenanceHealth: queries PyPI at the project-level endpoint", async () => {
  let requested = "";
  await scanDepMaintenanceHealth(pypiAdd("requests", "2.31.0"), async (url) => {
    requested = url;
    return jsonResponse({ releases: {} });
  });
  assert.equal(requested, "https://pypi.org/pypi/requests/json");
});

test("scanDepMaintenanceHealth: healthy npm and PyPI dependencies are not flagged", async () => {
  assert.deepEqual(await scanDepMaintenanceHealth(npmAdd("lodash"), npmFetch({ time: freshNpmTime })), []);
  assert.deepEqual(await scanDepMaintenanceHealth(pypiAdd("requests"), pypiFetch({ releases: freshPypiReleases })), []);
});

test("scanDepMaintenanceHealth: a scoped npm name is URL-encoded and still queryable", async () => {
  let requested = "";
  const findings = await scanDepMaintenanceHealth(npmAdd("@scope/pkg"), async (url) => {
    requested = url;
    return jsonResponse({ deprecated: "gone", time: freshNpmTime });
  });
  assert.equal(findings.length, 1);
  assert.match(requested, /%40scope%2Fpkg/); // encodeURIComponent applied to the scoped name
});

test("scanDepMaintenanceHealth: unsupported ecosystems and malformed names are never queried", async () => {
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "go.mod", patch: `@@ -1,0 +1,1 @@\n+require example.com/x v1.0.0` }, // Go — unsupported
      { path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "BadCaps": "^1.0.0"` }, // invalid npm name
    ],
  };
  let called = false;
  const out = await scanDepMaintenanceHealth(req, async () => {
    called = true;
    return status(200)();
  });
  assert.deepEqual(out, []);
  assert.equal(called, false); // nothing queryable → no registry call
});

test("scanDepMaintenanceHealth: only DIRECT added/upgraded deps are scanned (an upgrade is queried)", async () => {
  const upgrade = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [{ path: "package.json", patch: `@@ -1,1 +1,1 @@\n-  "request": "^1.0.0"\n+  "request": "^2.0.0"` }],
  };
  const findings = await scanDepMaintenanceHealth(upgrade, async () =>
    jsonResponse({ deprecated: "use a maintained fork", time: freshNpmTime }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].version, "2.0.0"); // the upgraded-to version is reported
});

test("scanDepMaintenanceHealth: the query cap counts only queryable changes (skips don't starve a real dep)", async () => {
  const goLines = Array.from({ length: 25 }, (_, i) => `+require example.com/m${i} v1.0.0`).join("\n");
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "go.mod", patch: `@@ -1,0 +1,25 @@\n${goLines}` },
      { path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "request": "^1.0.0"` },
    ],
  };
  const findings = await scanDepMaintenanceHealth(
    req,
    npmFetch({ deprecated: "gone", time: freshNpmTime }),
    { limits: { maxQueries: 25 } },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "request");
});

test("scanDepMaintenanceHealth: the query cap bounds total fetches", async () => {
  const lines = Array.from({ length: 5 }, (_, i) => `+  "pkg${i}": "^1.0.0"`).join("\n");
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [{ path: "package.json", patch: `@@ -1,0 +1,5 @@\n${lines}` }],
  };
  let calls = 0;
  await scanDepMaintenanceHealth(
    req,
    async () => {
      calls += 1;
      return jsonResponse({ time: freshNpmTime });
    },
    { limits: { maxQueries: 2 } },
  );
  assert.equal(calls, 2); // capped at maxQueries even though 5 deps were added
});

test("scanDepMaintenanceHealth fails safe on a non-ok or throwing fetch", async () => {
  assert.deepEqual(await scanDepMaintenanceHealth(npmAdd("request"), status(404)), []);
  assert.deepEqual(await scanDepMaintenanceHealth(npmAdd("request"), throwingFetch), []);
});

test("scanDepMaintenanceHealth fails safe on malformed registry JSON (npm + PyPI)", async () => {
  const malformed = async () => jsonResponse({ unexpected: "shape" });
  assert.deepEqual(await scanDepMaintenanceHealth(npmAdd("request"), malformed), []);
  assert.deepEqual(await scanDepMaintenanceHealth(pypiAdd("requests"), malformed), []);
});

test("scanDepMaintenanceHealth fails closed on an oversized registry body (content-length over the cap)", async () => {
  // A real deprecation is present, but the body is declared larger than the 2 MiB cap, so the bounded reader
  // returns null and nothing is flagged — an oversized packument cannot blow the analyzer budget.
  const oversized = async () =>
    new Response(JSON.stringify({ deprecated: "gone", time: freshNpmTime }), {
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    });
  assert.deepEqual(await scanDepMaintenanceHealth(npmAdd("request"), oversized), []);
});

test("pep440Key: pins the supported subset — epochs, post/dev ordering, local versions", () => {
  assert.equal(pep440Key("1!1.0"), "1!1"); // epoch preserved, trailing zero dropped
  assert.equal(pep440Key("1.0.post1.dev2"), "0!1post1dev2"); // post before dev
  assert.equal(pep440Key("1.0.dev0"), "0!1dev0");
  assert.equal(pep440Key("1.2.3+ubuntu.1"), pep440Key("1.2.3")); // local segment ignored for equality
  assert.notEqual(pep440Key("1.0.post1"), pep440Key("1.0.dev1")); // post and dev are distinct
});

test("pypiHealth: no finding when the requested version cannot be resolved to a published release (fail safe)", () => {
  // The requested version (1.0.0) is not present in `releases` (only 0.9.0 is), so we must NOT attribute a stale
  // (or any) finding to a version that may not exist on PyPI — even though the project itself looks old.
  assert.equal(
    pypiHealth(
      { releases: { "0.9.0": [{ upload_time_iso_8601: iso(NOW - 4 * YEAR_MS) }] } },
      "1.0.0",
      STALE_MS,
      NOW,
    ),
    null,
  );
  // But when the requested version DOES resolve, package staleness is still reported.
  const resolved = pypiHealth(
    { releases: { "1.0.0": [{ upload_time_iso_8601: iso(NOW - 4 * YEAR_MS) }] } },
    "1.0.0",
    STALE_MS,
    NOW,
  );
  assert.equal(resolved?.kind, "stale");
});

test("scanDepMaintenanceHealth stops on an already-aborted signal", async () => {
  const findings = await scanDepMaintenanceHealth(npmAdd("request"), npmFetch({ deprecated: "gone", time: freshNpmTime }), {
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(findings, []);
});

test("renderBrief emits a public-safe deprecated/stale block and escapes registry-supplied reasons", () => {
  const { promptSection } = renderBrief({
    depMaintenanceHealth: [
      { ecosystem: "npm", package: "request", version: "2.88.2", kind: "deprecated", reason: "deprecated by maintainer — use `axios`*injected*" },
      { ecosystem: "PyPI", package: "oldpkg", version: "0.1.0", kind: "stale", reason: "no release in ~5y (last upload 2020-01-01)" },
    ],
  });
  assert.match(promptSection, /Deprecated \/ stale dependencies/);
  assert.match(promptSection, /request@2\.88\.2/);
  assert.match(promptSection, /oldpkg@0\.1\.0/);
  assert.doesNotMatch(promptSection, /\*injected\*/); // markdown metacharacters from registry text are escaped
});

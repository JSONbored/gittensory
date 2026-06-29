import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { resolveReesSentryRelease, resolveTracesSampleRate } from "../src/sentry.ts";

test("resolveReesSentryRelease prefers explicit releases and falls back to Railway commit shas", () => {
  assert.equal(
    resolveReesSentryRelease({
      SENTRY_RELEASE: "custom-release",
      RAILWAY_GIT_COMMIT_SHA: "abc123",
    }),
    "custom-release",
  );
  assert.equal(resolveReesSentryRelease({ RAILWAY_GIT_COMMIT_SHA: "abc123" }), "gittensory-rees@abc123");
  assert.equal(resolveReesSentryRelease({}), undefined);
});

test("resolveTracesSampleRate clamps malformed or out-of-range config", () => {
  assert.equal(resolveTracesSampleRate({}), 0);
  assert.equal(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "0.25" }), 0.25);
  assert.equal(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "nope" }), 0);
  assert.equal(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "-1" }), 0);
  assert.equal(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "2" }), 1);
});

test("upload-sourcemaps calls Sentry CLI with release association on upload", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rees-sentry-cli-"));
  const logPath = resolve(dir, "calls.jsonl");
  const cliPath = resolve(dir, "sentry-cli");
  writeFileSync(
    cliPath,
    `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' '${logPath}' "$@"\n`,
  );
  chmodSync(cliPath, 0o755);

  const result = spawnSync(process.execPath, ["dist/upload-sourcemaps.js"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      SENTRY_AUTH_TOKEN: "test-token",
      SENTRY_ORG: "jsonbored",
      SENTRY_PROJECT: "rees",
      SENTRY_CLI_PATH: cliPath,
      RAILWAY_GIT_COMMIT_SHA: "abc123",
      RAILWAY_DEPLOYMENT_ID: "deploy-1",
      RAILWAY_ENVIRONMENT_NAME: "production",
      REES_SENTRY_UPLOAD_STRICT: "true",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

  assert.deepEqual(calls[0], [
    "releases",
    "--org",
    "jsonbored",
    "--project",
    "rees",
    "new",
    "gittensory-rees@abc123",
  ]);
  assert.deepEqual(calls[2], ["sourcemaps", "--org", "jsonbored", "--project", "rees", "inject", "dist"]);
  assert.deepEqual(calls[3], [
    "sourcemaps",
    "--org",
    "jsonbored",
    "--project",
    "rees",
    "upload",
    "--release",
    "gittensory-rees@abc123",
    "--validate",
    "--wait",
    "--strict",
    "dist",
  ]);
});

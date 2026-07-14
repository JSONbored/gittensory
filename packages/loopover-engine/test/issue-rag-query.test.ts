import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_QUERY_CHARS, buildIssueRagQuery } from "../dist/index.js";

test("barrel: the public entrypoint re-exports the issue-rag-query API", () => {
  assert.equal(typeof buildIssueRagQuery, "function");
  assert.equal(MIN_QUERY_CHARS, 40);
});

test("composes title, bounded body, and label hint in order", () => {
  const { queryText } = buildIssueRagQuery({
    title: "Improve SQLite backup readiness checks",
    body: "Operators need restore guidance tied to the existing self-host backup flow.",
    labels: ["gittensor:feature", "selfhost", "  "],
  });
  assert.ok(queryText.indexOf("Improve SQLite backup readiness checks") === 0);
  assert.ok(queryText.indexOf("Operators need") < queryText.indexOf("Labels:"));
  assert.ok(queryText.includes("Labels: gittensor:feature, selfhost"));
});

test("returns an empty query below the shared retrieval floor", () => {
  assert.deepEqual(buildIssueRagQuery({ title: "Tiny" }), { queryText: "" });
});

test("bounds long bodies without dropping the label hint", () => {
  const { queryText } = buildIssueRagQuery({
    title: "Investigate flaky queue dispatch telemetry",
    body: `${"a".repeat(4100)}SHOULD_NOT_APPEAR`,
    labels: ["queue"],
  });
  assert.ok(!queryText.includes("SHOULD_NOT_APPEAR"));
  assert.ok(queryText.includes("Labels: queue"));
});

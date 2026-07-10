import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateGateCheck } from "../dist/advisory/gate-advisory.js";
import type { Advisory } from "../dist/types/predicted-gate-types.js";

// #4518 engine-parity port: linkedIssueSatisfactionGateMode (#1961/#3906) was live in the host copy
// (src/rules/advisory.ts) but missing from this engine twin -- a locally-installed @jsonbored/gittensory-engine
// consumer configured with this gate mode would have silently under-predicted a block the live gate applies.
// Mirrors test/unit/gate-check-policy.test.ts's own "linked-issue satisfaction gate blocker" cases.
function satisfactionAdvisory(): Advisory {
  return {
    id: "test-advisory",
    targetType: "pull_request",
    targetKey: "owner/repo#1",
    repoFullName: "owner/repo",
    conclusion: "neutral",
    severity: "warning",
    title: "Gittensory advisory available",
    summary: "1 advisory finding generated.",
    findings: [
      {
        code: "linked_issue_scope_mismatch",
        title: "Linked issue does not appear to be satisfied",
        severity: "warning",
        detail: "The cited issue asks for an SSE stream; this PR adds an unrelated REST endpoint.",
        action: "Confirm this PR actually addresses the linked issue's scope, or link the correct issue.",
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

test("linked-issue satisfaction gate (#4518): blocks (failure) under linkedIssueSatisfactionGateMode: block", () => {
  const result = evaluateGateCheck(satisfactionAdvisory(), { linkedIssueSatisfactionGateMode: "block" });
  assert.equal(result.conclusion, "failure");
  assert.ok(result.blockers.some((b) => b.code === "linked_issue_scope_mismatch"));
});

test("linked-issue satisfaction gate (#4518): stays advisory (never blocks) under off/unset (default) or advisory mode", () => {
  assert.equal(evaluateGateCheck(satisfactionAdvisory(), {}).conclusion, "success"); // unset -> defaults to advisory
  assert.equal(evaluateGateCheck(satisfactionAdvisory(), { linkedIssueSatisfactionGateMode: "off" }).conclusion, "success");
  const advisoryResult = evaluateGateCheck(satisfactionAdvisory(), { linkedIssueSatisfactionGateMode: "advisory" });
  assert.equal(advisoryResult.conclusion, "success");
  assert.ok(advisoryResult.warnings.some((w) => w.code === "linked_issue_scope_mismatch"));
});

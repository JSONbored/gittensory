import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isDuplicateClusterWinner,
  isDuplicateClusterWinnerByClaim,
  resolveDuplicateClusterWinnerNumber,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the duplicate-winner adjudication API", () => {
  assert.equal(typeof isDuplicateClusterWinner, "function");
  assert.equal(typeof isDuplicateClusterWinnerByClaim, "function");
  assert.equal(typeof resolveDuplicateClusterWinnerNumber, "function");
});

test("isDuplicateClusterWinner: the lowest open sibling number wins", () => {
  assert.equal(isDuplicateClusterWinner(5, [7, 9]), true);
});

test("isDuplicateClusterWinner: a lower open sibling beats this PR (loser)", () => {
  assert.equal(isDuplicateClusterWinner(5, [3, 9]), false);
});

test("isDuplicateClusterWinner: an empty sibling list is always a winner", () => {
  assert.equal(isDuplicateClusterWinner(5, []), true);
});

test("isDuplicateClusterWinnerByClaim: an empty sibling list is always a winner", () => {
  assert.equal(isDuplicateClusterWinnerByClaim({ number: 5 }, []), true);
});

test("isDuplicateClusterWinnerByClaim: elects the earliest observed linked-issue claimant, not the lowest PR number", () => {
  const earlier = { number: 9, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  const later = { number: 3, linkedIssueClaimedAt: "2026-01-02T00:00:00Z" };
  assert.equal(isDuplicateClusterWinnerByClaim(earlier, [later]), true);
  assert.equal(isDuplicateClusterWinnerByClaim(later, [earlier]), false);
});

test("isDuplicateClusterWinnerByClaim: falls back to PR number for an equal known claim timestamp", () => {
  const a = { number: 3, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  const b = { number: 9, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  assert.equal(isDuplicateClusterWinnerByClaim(a, [b]), true);
  assert.equal(isDuplicateClusterWinnerByClaim(b, [a]), false);
});

test("isDuplicateClusterWinnerByClaim: fails closed when sparse legacy rows lack claim timestamps", () => {
  assert.equal(isDuplicateClusterWinnerByClaim({ number: 5 }, [{ number: 9 }]), false);
});

test("isDuplicateClusterWinnerByClaim: fails closed on an invalid claim timestamp", () => {
  assert.equal(
    isDuplicateClusterWinnerByClaim({ number: 5, linkedIssueClaimedAt: "not-a-date" }, [{ number: 9, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" }]),
    false,
  );
});

// #3956 (anti-backdating): createdAt is deliberately NOT part of the election (see
// prPrecedesSibling's doc comment in src/duplicate-winner.ts) -- an older PR could otherwise steal
// winner credit by editing its body to claim the linked issue later. This block replaces three
// stale "createdAt precedence" tests that asserted the OLD, since-removed createdAt-based ordering
// (root test/unit/duplicate-winner.test.ts was updated for the same fix in #3956; this package's
// own parallel test file wasn't, because it isn't part of test:ci and nobody noticed).
test("isDuplicateClusterWinnerByClaim: ignores createdAt even when present on both sides, decides purely by claim time", () => {
  const openedFirstButClaimedLater = {
    number: 9,
    createdAt: "2026-01-01T00:00:00Z",
    linkedIssueClaimedAt: "2026-01-05T00:00:00Z",
  };
  const openedSecondButClaimedFirst = {
    number: 3,
    createdAt: "2026-01-02T00:00:00Z",
    linkedIssueClaimedAt: "2026-01-01T00:00:00Z",
  };
  // openedSecondButClaimedFirst claimed earlier, so it wins despite its later createdAt.
  assert.equal(isDuplicateClusterWinnerByClaim(openedFirstButClaimedLater, [openedSecondButClaimedFirst]), false);
  assert.equal(isDuplicateClusterWinnerByClaim(openedSecondButClaimedFirst, [openedFirstButClaimedLater]), true);
});

test("isDuplicateClusterWinnerByClaim: still fails closed when createdAt is present but claim timing is missing", () => {
  const a = { number: 12, createdAt: "2026-06-29T10:00:00.000Z" };
  const b = { number: 13, createdAt: "2026-06-29T10:05:00.000Z" };
  assert.equal(isDuplicateClusterWinnerByClaim(a, [b]), false);
  assert.equal(isDuplicateClusterWinnerByClaim(b, [a]), false);
});

test("resolveDuplicateClusterWinnerNumber: returns this PR's own number when it is the winner", () => {
  const pr = { number: 5, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  const sibling = { number: 9, linkedIssueClaimedAt: "2026-01-02T00:00:00Z" };
  assert.equal(resolveDuplicateClusterWinnerNumber(pr, [sibling]), 5);
});

test("resolveDuplicateClusterWinnerNumber: returns the actual winning sibling's number when this PR is a loser", () => {
  const pr = { number: 9, linkedIssueClaimedAt: "2026-01-02T00:00:00Z" };
  const sibling = { number: 5, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  assert.equal(resolveDuplicateClusterWinnerNumber(pr, [sibling]), 5);
});

test("resolveDuplicateClusterWinnerNumber: an empty sibling list means this PR wins by default", () => {
  assert.equal(resolveDuplicateClusterWinnerNumber({ number: 5 }, []), 5);
});

test("resolveDuplicateClusterWinnerNumber: returns null when the election is too ambiguous to name a specific winner", () => {
  // Every member lacks a claim timestamp, so no one can be proven the winner (fails closed).
  assert.equal(resolveDuplicateClusterWinnerNumber({ number: 5 }, [{ number: 9 }, { number: 3 }]), null);
});

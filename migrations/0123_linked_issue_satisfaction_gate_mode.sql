-- Linked-issue satisfaction gate (#1961/#3906). Off by default -- byte-identical to today for every repo
-- that doesn't opt in. When "advisory", an AI assessment of whether the PR's diff satisfies its primary
-- linked issue's intent renders in the review comment but never blocks. When "block", a confidence-floor-
-- passing "unaddressed" verdict additionally becomes a hard blocker (linked_issue_scope_mismatch), closing
-- the gap where the deterministic linked-issue check only verified existence/openness, never scope match
-- (JSONbored/metagraphed PR #3910's repro: a cited issue asked for an SSE stream, the PR delivered an
-- unrelated REST endpoint, and the structured "Linked issue" signal still read "Linked" with no blocker).
ALTER TABLE repository_settings ADD COLUMN linked_issue_satisfaction_gate_mode TEXT NOT NULL DEFAULT 'off';

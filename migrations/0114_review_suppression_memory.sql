-- Review memory (#2178, data-model slice of #1964): a bounded, public-safe per-repo store of "the maintainer
-- already dismissed this as a false positive" suppression signals. A maintainer-authored suppression is keyed
-- by (repo_full_name, category, path_glob, pattern_hash): `category` is the finding's own deterministic `code`
-- (e.g. "ai_review_split", never a private rubric term), `path_glob` narrows the suppression to a path pattern
-- ("" = repo-wide), and `pattern_hash` is a stable hash of the finding's NORMALIZED message (never the raw
-- message itself — no free-form finding text is stored, only its hash, keeping the row public-safe). Recording
-- (writing a row when a maintainer dismisses a finding) and applying (reading rows to suppress a future
-- matching finding) are both SEPARATE slices layered on top of this store — this migration adds ONLY the table
-- + typed row + repository accessors, no recording trigger and no apply-during-review logic.
CREATE TABLE IF NOT EXISTS review_suppression (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  category TEXT NOT NULL,
  path_glob TEXT NOT NULL DEFAULT '',
  pattern_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT
);
-- Idempotent recording: re-dismissing the SAME finding shape is a no-op upsert (bump created_at), not a
-- duplicate row -- mirrors active_review_tracking's one-row-per-key shape (migrations/0113).
CREATE UNIQUE INDEX IF NOT EXISTS review_suppression_key_unique
  ON review_suppression (repo_full_name, category, path_glob, pattern_hash);
-- Per-repo listing + the bounded-row-cap eviction (oldest-first) both scan by repo_full_name ordered by
-- created_at -- this index serves both without a table scan.
CREATE INDEX IF NOT EXISTS review_suppression_repo_created_idx
  ON review_suppression (repo_full_name, created_at);

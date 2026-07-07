-- Linked-issue satisfaction assessment cache (#1961/#3906): mirrors ai_slop_cache (migration 0119) -- the
-- assessment makes a real, bounded-retry LLM call with no caching, so a repeated scheduled sweep pass would
-- re-spend it on every tick even at an unchanged head SHA. The PRIMARY KEY additionally includes
-- linked_issue_number (unlike ai_slop_cache) because a PR's cited PRIMARY linked issue can change between
-- passes (an edited body re-links a different issue) -- reusing a stored verdict for a DIFFERENT issue would
-- silently answer the wrong question.
CREATE TABLE IF NOT EXISTS linked_issue_satisfaction_cache (
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  linked_issue_number INTEGER NOT NULL,
  -- Fingerprints the one input that can change independently of the head SHA + issue number: which provider
  -- produced the opinion (free/default reviewer vs. a maintainer's BYOK key/model).
  input_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_full_name, pull_number, head_sha, linked_issue_number)
);

-- Impact-map query cache retention (#4500 follow-up): computeImpactMap now evicts expired rows on
-- read-miss and proactively deletes stale rows before every insert, both scoped by (project, repo,
-- fetched_at). Migration 0132 shipped without this index -- an already-applied migration's SQL is
-- NOT retroactively re-run, so the index must land as its own migration rather than editing 0132.
CREATE INDEX IF NOT EXISTS impact_map_query_cache_repo_fetched_at_idx
  ON impact_map_query_cache (project, repo, fetched_at);

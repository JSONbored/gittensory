CREATE TABLE IF NOT EXISTS repo_sync_segments (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  segment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'never_synced',
  source_kind TEXT NOT NULL DEFAULT 'github',
  mode TEXT NOT NULL DEFAULT 'light',
  last_cursor TEXT,
  next_cursor TEXT,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  expected_count INTEGER,
  page_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  stale_at TEXT,
  rate_limit_reset_at TEXT,
  etag TEXT,
  last_modified TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_summary TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_full_name, segment)
);

CREATE INDEX IF NOT EXISTS repo_sync_segments_repo_status_idx
  ON repo_sync_segments (repo_full_name, status);

CREATE INDEX IF NOT EXISTS repo_sync_segments_segment_status_idx
  ON repo_sync_segments (segment, status, updated_at);

CREATE TABLE IF NOT EXISTS github_rate_limit_observations (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT,
  resource TEXT NOT NULL DEFAULT 'rest',
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  limit_value INTEGER,
  remaining INTEGER,
  reset_at TEXT,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS github_rate_limit_observations_repo_observed_idx
  ON github_rate_limit_observations (repo_full_name, observed_at);

CREATE INDEX IF NOT EXISTS github_rate_limit_observations_reset_idx
  ON github_rate_limit_observations (reset_at);

CREATE INDEX IF NOT EXISTS pull_requests_author_repo_state_idx
  ON pull_requests (author_login, repo_full_name, state);

CREATE INDEX IF NOT EXISTS issues_author_repo_state_idx
  ON issues (author_login, repo_full_name, state);

CREATE INDEX IF NOT EXISTS recent_merged_pull_requests_author_repo_merged_idx
  ON recent_merged_pull_requests (author_login, repo_full_name, merged_at);

CREATE INDEX IF NOT EXISTS signal_snapshots_repo_signal_generated_idx
  ON signal_snapshots (repo_full_name, signal_type, generated_at);

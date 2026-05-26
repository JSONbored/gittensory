CREATE TABLE IF NOT EXISTS repo_github_totals_snapshots (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  open_issues_total INTEGER NOT NULL DEFAULT 0,
  open_pull_requests_total INTEGER NOT NULL DEFAULT 0,
  merged_pull_requests_total INTEGER NOT NULL DEFAULT 0,
  closed_unmerged_pull_requests_total INTEGER NOT NULL DEFAULT 0,
  labels_total INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL DEFAULT 'github',
  fetched_at TEXT NOT NULL,
  rate_limit_remaining INTEGER,
  rate_limit_reset_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS repo_github_totals_repo_fetched_idx
  ON repo_github_totals_snapshots(repo_full_name, fetched_at);

CREATE TABLE IF NOT EXISTS pull_request_detail_sync_state (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'never_synced',
  files_synced_at TEXT,
  reviews_synced_at TEXT,
  checks_synced_at TEXT,
  last_synced_at TEXT,
  error_summary TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS pull_request_detail_sync_repo_pull_unique
  ON pull_request_detail_sync_state(repo_full_name, pull_number);

CREATE INDEX IF NOT EXISTS pull_request_detail_sync_repo_status_idx
  ON pull_request_detail_sync_state(repo_full_name, status);

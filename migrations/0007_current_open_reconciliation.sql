ALTER TABLE pull_requests ADD COLUMN last_seen_open_at TEXT;
ALTER TABLE issues ADD COLUMN last_seen_open_at TEXT;

CREATE INDEX IF NOT EXISTS pull_requests_repo_state_seen_idx
  ON pull_requests (repo_full_name, state, last_seen_open_at);

CREATE INDEX IF NOT EXISTS issues_repo_state_seen_idx
  ON issues (repo_full_name, state, last_seen_open_at);

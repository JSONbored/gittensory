ALTER TABLE repository_settings ADD COLUMN check_run_detail_level TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE repository_settings ADD COLUMN backfill_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repository_settings ADD COLUMN private_trust_enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS repo_sync_state (
  repo_full_name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'never_synced',
  source_kind TEXT NOT NULL DEFAULT 'github',
  primary_language TEXT,
  default_branch TEXT,
  is_private INTEGER,
  open_issues_count INTEGER NOT NULL DEFAULT 0,
  open_pull_requests_count INTEGER NOT NULL DEFAULT 0,
  recent_merged_pull_requests_count INTEGER NOT NULL DEFAULT 0,
  labels_synced_at TEXT,
  issues_synced_at TEXT,
  pull_requests_synced_at TEXT,
  merged_pull_requests_synced_at TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  error_summary TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repo_labels (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  description TEXT,
  is_configured INTEGER NOT NULL DEFAULT 0,
  observed_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_full_name, name)
);

CREATE INDEX IF NOT EXISTS repo_labels_repo_idx ON repo_labels (repo_full_name);

CREATE TABLE IF NOT EXISTS repo_snapshots (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'github',
  fetched_at TEXT NOT NULL,
  primary_language TEXT,
  default_branch TEXT,
  open_issues_count INTEGER NOT NULL DEFAULT 0,
  open_pull_requests_count INTEGER NOT NULL DEFAULT 0,
  recent_merged_pull_requests_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS repo_snapshots_repo_idx ON repo_snapshots (repo_full_name, fetched_at);

CREATE TABLE IF NOT EXISTS pull_request_files (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0,
  previous_filename TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_full_name, pull_number, path)
);

CREATE INDEX IF NOT EXISTS pull_request_files_repo_pull_idx ON pull_request_files (repo_full_name, pull_number);

CREATE TABLE IF NOT EXISTS pull_request_reviews (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  reviewer_login TEXT,
  state TEXT NOT NULL,
  author_association TEXT,
  submitted_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pull_request_reviews_repo_pull_idx ON pull_request_reviews (repo_full_name, pull_number);

CREATE TABLE IF NOT EXISTS check_summaries (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER,
  head_sha TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  started_at TEXT,
  completed_at TEXT,
  details_url TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_full_name, head_sha, name)
);

CREATE INDEX IF NOT EXISTS check_summaries_repo_pull_idx ON check_summaries (repo_full_name, pull_number);

CREATE TABLE IF NOT EXISTS recent_merged_pull_requests (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author_login TEXT,
  html_url TEXT,
  merged_at TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  linked_issues_json TEXT NOT NULL DEFAULT '[]',
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_full_name, number)
);

CREATE INDEX IF NOT EXISTS recent_merged_pull_requests_repo_idx ON recent_merged_pull_requests (repo_full_name, merged_at);

CREATE TABLE IF NOT EXISTS contributors (
  login TEXT PRIMARY KEY,
  github_profile_json TEXT NOT NULL DEFAULT '{}',
  top_languages_json TEXT NOT NULL DEFAULT '[]',
  public_repos INTEGER,
  followers INTEGER,
  source TEXT NOT NULL DEFAULT 'github',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contributor_repo_stats (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  pull_requests INTEGER NOT NULL DEFAULT 0,
  merged_pull_requests INTEGER NOT NULL DEFAULT 0,
  open_pull_requests INTEGER NOT NULL DEFAULT 0,
  issues INTEGER NOT NULL DEFAULT 0,
  stale_pull_requests INTEGER NOT NULL DEFAULT 0,
  unlinked_pull_requests INTEGER NOT NULL DEFAULT 0,
  dominant_labels_json TEXT NOT NULL DEFAULT '[]',
  last_activity_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(login, repo_full_name)
);

CREATE INDEX IF NOT EXISTS contributor_repo_stats_login_idx ON contributor_repo_stats (login);
CREATE INDEX IF NOT EXISTS contributor_repo_stats_repo_idx ON contributor_repo_stats (repo_full_name);

CREATE TABLE IF NOT EXISTS collision_edges (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  left_type TEXT NOT NULL,
  left_number INTEGER NOT NULL,
  left_title TEXT NOT NULL,
  right_type TEXT NOT NULL,
  right_number INTEGER NOT NULL,
  right_title TEXT NOT NULL,
  risk TEXT NOT NULL,
  reason TEXT NOT NULL,
  shared_terms_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS collision_edges_repo_idx ON collision_edges (repo_full_name, generated_at);

CREATE TABLE IF NOT EXISTS signal_snapshots (
  id TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  repo_full_name TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS signal_snapshots_target_idx ON signal_snapshots (signal_type, target_key, generated_at);

CREATE TABLE IF NOT EXISTS installation_health (
  installation_id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  repository_selection TEXT,
  installed_repos_count INTEGER NOT NULL DEFAULT 0,
  registered_installed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  missing_permissions_json TEXT NOT NULL DEFAULT '[]',
  missing_events_json TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  events_json TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT NOT NULL,
  error_summary TEXT
);

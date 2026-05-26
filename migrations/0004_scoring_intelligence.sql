CREATE TABLE IF NOT EXISTS scoring_model_snapshots (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  active_model TEXT NOT NULL,
  constants_json TEXT NOT NULL DEFAULT '{}',
  programming_languages_json TEXT NOT NULL DEFAULT '{}',
  registry_snapshot_id TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS scoring_model_snapshots_fetched_at_idx
  ON scoring_model_snapshots (fetched_at);

CREATE TABLE IF NOT EXISTS score_previews (
  id TEXT PRIMARY KEY,
  scoring_model_snapshot_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  contributor_login TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS score_previews_repo_target_idx
  ON score_previews (repo_full_name, target_key, generated_at);

CREATE TABLE IF NOT EXISTS contributor_evidence (
  login TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contributor_scoring_profiles (
  login TEXT PRIMARY KEY,
  scoring_model_snapshot_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS issue_quality_reports (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS issue_quality_reports_repo_issue_unique
  ON issue_quality_reports (repo_full_name, issue_number);

CREATE TABLE IF NOT EXISTS burden_forecasts (
  repo_full_name TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registry_drift_events (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  drift_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  previous_snapshot_id TEXT,
  current_snapshot_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS registry_drift_events_repo_idx
  ON registry_drift_events (repo_full_name, generated_at);

CREATE TABLE IF NOT EXISTS bounty_lifecycle_events (
  id TEXT PRIMARY KEY,
  bounty_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS bounty_lifecycle_events_bounty_idx
  ON bounty_lifecycle_events (bounty_id, generated_at);

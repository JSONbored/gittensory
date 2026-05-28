CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY NOT NULL,
  objective TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  surface TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'copilot',
  status TEXT NOT NULL DEFAULT 'queued',
  data_quality_status TEXT NOT NULL DEFAULT 'unknown',
  error_summary TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX agent_runs_actor_updated_idx ON agent_runs (actor_login, updated_at);
CREATE INDEX agent_runs_status_updated_idx ON agent_runs (status, updated_at);
CREATE INDEX agent_runs_surface_updated_idx ON agent_runs (surface, updated_at);

CREATE TABLE agent_actions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_repo_full_name TEXT,
  target_pull_number INTEGER,
  target_issue_number INTEGER,
  status TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  why_json TEXT NOT NULL DEFAULT '[]',
  scoreability_impact TEXT,
  risk_impact TEXT,
  maintainer_impact TEXT,
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  rerun_when TEXT,
  public_safe_summary TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 1,
  safety_class TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX agent_actions_run_action_idx ON agent_actions (run_id, action_type);
CREATE INDEX agent_actions_target_repo_idx ON agent_actions (target_repo_full_name, created_at);

CREATE TABLE agent_context_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  decision_pack_version TEXT,
  repo_signal_snapshot_ids_json TEXT NOT NULL DEFAULT '[]',
  scoring_model_id TEXT,
  freshness_warnings_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX agent_context_snapshots_run_created_idx ON agent_context_snapshots (run_id, created_at);

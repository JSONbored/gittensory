-- Linear adapter for project/milestone matching (#3186): lets a repo point auto-project/milestone matching
-- (#3183/#3184) at Linear instead of GitHub Projects/Milestones. Defaults to 'github' (opt-in switch, no
-- behavior change for existing repos). The Linear API key itself is NEVER stored here or in
-- repository_settings -- it lives in its own isolated table (mirroring repository_ai_keys' BYOK pattern, see
-- migrations/0027_repository_ai_keys.sql) so it is never serialized by the repository-settings GET surface,
-- and is encrypted at rest the same way (AES-256-GCM, see src/utils/crypto.ts).
ALTER TABLE repository_settings ADD COLUMN auto_project_milestone_match_backend TEXT NOT NULL DEFAULT 'github';

CREATE TABLE IF NOT EXISTS repository_linear_keys (
  repo_full_name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  salt TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  last4 TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

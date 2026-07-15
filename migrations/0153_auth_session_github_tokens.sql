-- Persist the GitHub user-to-server token minted during login (#6114), encrypted at rest with AES-256-GCM
-- (see src/utils/crypto.ts). Previously this token was fetched, used once to verify identity, then discarded --
-- so a CLI/AMS process had no way to authenticate git operations without a separately-configured GITHUB_TOKEN
-- PAT. Isolated in its own table (mirroring repository_ai_keys/repository_linear_keys' pattern, see
-- migrations/0027_repository_ai_keys.sql) rather than a column on auth_sessions itself, so the main session
-- lookup (used on every authenticated request) never touches the encrypted token, and a future bug that
-- serializes a full auth_sessions row can't leak it.
CREATE TABLE IF NOT EXISTS auth_session_github_tokens (
  session_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  salt TEXT,
  key_version INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES auth_sessions (id)
);

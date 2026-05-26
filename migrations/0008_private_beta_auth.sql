CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  github_user_id INTEGER,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS auth_sessions_login_idx ON auth_sessions(login);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_revoked_idx ON auth_sessions(revoked_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT,
  route TEXT,
  target_key TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS audit_events_type_created_idx ON audit_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS audit_events_actor_created_idx ON audit_events(actor, created_at);
CREATE INDEX IF NOT EXISTS audit_events_route_created_idx ON audit_events(route, created_at);

-- Pull-mode relay backlog coalescing: keep only the newest pending row for webhook classes where later delivery
-- supersedes earlier equivalent work (CI completion / PR refresh), while preserving terminal lifecycle events.
ALTER TABLE orb_relay_pending ADD COLUMN coalesce_key TEXT;
CREATE INDEX IF NOT EXISTS idx_orb_relay_pending_coalesce
  ON orb_relay_pending (installation_id, coalesce_key)
  WHERE coalesce_key IS NOT NULL;

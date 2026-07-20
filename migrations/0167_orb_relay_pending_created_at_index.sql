-- #7430: pruneRelayPending (run on every pull-mode relay-drain, fleet-wide, every 30s) filters
-- orb_relay_pending by a bare created_at predicate:
--   SELECT ... WHERE created_at < ? ORDER BY created_at, delivery_id LIMIT ?
--   DELETE     WHERE created_at < ?
-- Both existing indexes lead with installation_id (idx_orb_relay_pending_install /
-- idx_orb_relay_pending_coalesce), so neither serves a created_at-only predicate — the SELECT and
-- DELETE full-scan the table and can exceed the pull request's AbortSignal.timeout(30_000) budget.
-- A (created_at, delivery_id) index turns both into range scans and lets the SELECT satisfy its
-- ORDER BY (created_at, delivery_id) from the index without a sort.
CREATE INDEX IF NOT EXISTS idx_orb_relay_pending_created_at ON orb_relay_pending (created_at, delivery_id);

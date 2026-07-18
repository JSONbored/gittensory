-- Centralized hosted billing (#7176, part of the #7173 shared control-plane): ai_usage_events records AI
-- usage/cost per event but had no tenant column -- identity was only recoverable indirectly via
-- actor/route/metadata_json. A central aggregator (shared by ORB + AMS) needs a real column to attribute usage
-- without parsing free-form metadata. Nullable + backfilled-null: self-host has no installation concept and
-- keeps working unchanged; hosted containers populate it at insert time. Applies to BOTH this table's purposes
-- (AI usage AND the BYOK `byok:...` key-lifecycle audit log double-purpose).
ALTER TABLE ai_usage_events ADD COLUMN installation_id TEXT;

-- Covers the per-tenant billing aggregate (sumAiCostForTenantSince): WHERE installation_id = ? AND created_at >= ?.
CREATE INDEX IF NOT EXISTS ai_usage_events_installation_created_idx ON ai_usage_events (installation_id, created_at);

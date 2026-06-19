-- Advisory newcomer-PR auto-guide (#803, Phase-1-lite). When enabled, the webhook posts a one-time
-- welcoming advisory comment on first-time-contributor PRs (0 merged PRs in the repo). Advisory
-- only — never blocks, never auto-merges. Reuses the #552 newcomer detection. Default 'off'.
ALTER TABLE repository_settings ADD COLUMN newcomer_guide_mode TEXT NOT NULL DEFAULT 'off';

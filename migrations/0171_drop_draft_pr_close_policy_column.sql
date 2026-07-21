-- Config-as-code migration (epic #6440, #draft-pr-close-policy): draftPrClosePolicy now parses correctly
-- from .loopover.yml's settings: block and resolveEffectiveSettings already overlays it via the generic
-- {...dbSettings, ...restManifestSettings} spread (no special-casing needed) -- same shape as the
-- reviewEvasionProtection/mergeTrainMode fields Batch B (migration 0158) already dropped for. This column
-- was added in 0156, one migration before the Batch A/B cleanup (0157/0158) began, and was never swept into
-- that wave -- this migration closes that gap. Same dead-column-cleanup shape as Batches A-D
-- (0157/0158/0159/0160/0162): SQLite 3.35+ / D1 supports DROP COLUMN directly.
ALTER TABLE repository_settings DROP COLUMN draft_pr_close_policy;

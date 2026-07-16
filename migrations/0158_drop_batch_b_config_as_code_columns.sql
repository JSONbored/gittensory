-- Config-as-code migration (Batch B, loopover#6443): these 15 fields parse correctly from a repo's
-- .loopover.yml settings: block and resolveEffectiveSettings overlays manifest settings unconditionally.
-- Removing their per-repo DB columns leaves a single source of truth: manifest override, else the
-- built-in default returned by getRepositorySettings. The global_contributor_blacklist table remains;
-- only repository_settings.contributor_blacklist_json is removed.
-- SQLite 3.35+ / D1 supports DROP COLUMN directly (same precedent as 0122/0146/0150).
ALTER TABLE repository_settings DROP COLUMN gittensor_label;
ALTER TABLE repository_settings DROP COLUMN blacklist_label;
ALTER TABLE repository_settings DROP COLUMN create_missing_label;
ALTER TABLE repository_settings DROP COLUMN type_labels_enabled;
ALTER TABLE repository_settings DROP COLUMN type_labels_json;
ALTER TABLE repository_settings DROP COLUMN linked_issue_label_propagation_json;
ALTER TABLE repository_settings DROP COLUMN contributor_blacklist_json;
ALTER TABLE repository_settings DROP COLUMN moderation_gate_mode;
ALTER TABLE repository_settings DROP COLUMN moderation_rules_json;
ALTER TABLE repository_settings DROP COLUMN moderation_warning_label;
ALTER TABLE repository_settings DROP COLUMN moderation_banned_label;
ALTER TABLE repository_settings DROP COLUMN review_evasion_protection;
ALTER TABLE repository_settings DROP COLUMN review_evasion_label;
ALTER TABLE repository_settings DROP COLUMN review_evasion_comment;
ALTER TABLE repository_settings DROP COLUMN merge_train_mode;

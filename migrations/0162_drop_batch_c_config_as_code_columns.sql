-- Config-as-code migration (Batch C, loopover#6444, epic #6440): reviewCheckMode, linkedIssueGateMode,
-- duplicatePrGateMode, qualityGateMode, qualityGateMinScore, selfAuthoredLinkedIssueGateMode,
-- aiReviewMode, aiReviewByok, aiReviewProvider, aiReviewModel, and aiReviewAllAuthors already resolved
-- correctly from .loopover.yml's settings.*/gate.* blocks; the repository_settings DB columns were a
-- redundant second source of truth resolveEffectiveSettings's manifest overlay already fully shadowed.
-- SQLite 3.35+ / D1 supports DROP COLUMN directly (same precedent as 0122/0146/0150/0157/0158/0159).
ALTER TABLE repository_settings DROP COLUMN review_check_mode;
ALTER TABLE repository_settings DROP COLUMN linked_issue_gate_mode;
ALTER TABLE repository_settings DROP COLUMN duplicate_pr_gate_mode;
ALTER TABLE repository_settings DROP COLUMN quality_gate_mode;
ALTER TABLE repository_settings DROP COLUMN quality_gate_min_score;
ALTER TABLE repository_settings DROP COLUMN self_authored_linked_issue_gate_mode;
ALTER TABLE repository_settings DROP COLUMN ai_review_mode;
ALTER TABLE repository_settings DROP COLUMN ai_review_byok;
ALTER TABLE repository_settings DROP COLUMN ai_review_provider;
ALTER TABLE repository_settings DROP COLUMN ai_review_model;
ALTER TABLE repository_settings DROP COLUMN ai_review_all_authors;

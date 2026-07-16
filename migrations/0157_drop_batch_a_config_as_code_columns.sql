-- Config-as-code migration (Batch A, loopover#6442/epic #6440): these 9 fields already parse correctly
-- from .loopover.yml's settings: block (confirmed via audit, zero silent-discard bugs) and resolveEffectiveSettings
-- already overlays manifest settings over the DB value unconditionally -- so once the DB value itself
-- stops carrying a real per-repo override (getRepositorySettings now returns the same built-in default for
-- every repo instead of a live column), the effective behavior collapses to "manifest override, else
-- built-in default": genuine config-as-code, no more DB-vs-yml dual-source ambiguity for these fields.
-- badgeEnabled/publicQualityMetrics are DELIBERATELY excluded and stay DB-only forever: src/api/routes.ts's
-- loadPublicRepoBadge/loadPublicRepoQualityMetrics read them via a direct getRepositorySettings call that
-- bypasses the manifest overlay entirely, a documented perf tradeoff for two unauthenticated, high-frequency
-- public routes (no manifest-cache lookup, no possible cold-cache GitHub fetch, on every image/API load).
-- SQLite 3.35+ / D1 supports DROP COLUMN directly (same precedent as 0122/0146/0150).
ALTER TABLE repository_settings DROP COLUMN comment_mode;
ALTER TABLE repository_settings DROP COLUMN public_audience_mode;
ALTER TABLE repository_settings DROP COLUMN public_signal_level;
ALTER TABLE repository_settings DROP COLUMN check_run_mode;
ALTER TABLE repository_settings DROP COLUMN check_run_detail_level;
ALTER TABLE repository_settings DROP COLUMN regate_sweep_order_mode;
ALTER TABLE repository_settings DROP COLUMN public_surface;
ALTER TABLE repository_settings DROP COLUMN include_maintainer_authors;
ALTER TABLE repository_settings DROP COLUMN backfill_enabled;

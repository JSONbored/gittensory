-- Dead-column cleanup (#5373). gate_check_mode has been a computed read-back of review_check_mode only
-- since #4618 (0107_repository_review_check_mode.sql backfilled review_check_mode from it and made it the
-- real publish authority): getRepositorySettings/upsertRepositorySettings in db/repositories.ts have re-derived
-- it from review_check_mode on every read and write since then, self-healing any stale stored value. The
-- stored column itself has carried no independent information for any live row since that migration.
-- SQLite 3.35+ / D1 supports DROP COLUMN directly (same precedent as 0122_drop_private_trust_enabled.sql).
ALTER TABLE repository_settings DROP COLUMN gate_check_mode;

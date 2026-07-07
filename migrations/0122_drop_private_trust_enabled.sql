-- Dead-code cleanup (#4012). private_trust_enabled was persisted and exposed via the maintainer settings
-- API but read by zero conditional logic anywhere in src/ -- only ever assigned and passed through. Its doc
-- comment described gating "private trust signals in scoring", which this repo's house rules explicitly
-- forbid wiring in (no trust scores / reward values anywhere), so the correct disposition is removal, not
-- implementation. SQLite 3.35+ / D1 supports DROP COLUMN directly.
ALTER TABLE repository_settings DROP COLUMN private_trust_enabled;

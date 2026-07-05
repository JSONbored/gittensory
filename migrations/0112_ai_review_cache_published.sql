-- #regate-churn: once an AI review has actually been PUBLISHED to a PR (a real comment/check-run reached
-- GitHub), it becomes the authoritative result for that exact head+fingerprint and must never be silently
-- regenerated just because AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS elapsed -- the cooldown exists to bound
-- reuse BEFORE the first publish (e.g. overlapping sweep passes), not to force a periodic re-run of an
-- already-surfaced verdict. `published_at` (NULL until the publish step stamps it) lets getCachedAiReview treat
-- a published non-cacheable row as indefinitely reusable, same as a genuinely cacheable one, for this exact
-- head+fingerprint -- see putCachedAiReview/markAiReviewPublished in src/db/repositories.ts.
ALTER TABLE ai_review_cache ADD COLUMN published_at TEXT;

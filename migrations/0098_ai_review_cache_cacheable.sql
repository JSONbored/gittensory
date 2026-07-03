-- #regate-churn: the AI review cache (#1462) previously only ever stored genuinely reusable ("cacheable")
-- reviews -- a consensus-defect / inconclusive / lock-contention outcome was deliberately never written, so
-- nothing stopped a scheduled re-gate sweep from re-spending a real LLM call on the SAME head+fingerprint on
-- every single pass while a PR sat in that non-cacheable state (observed: one PR generated 281 AI review
-- calls in 24h against a single, never-reusable head). `cacheable` lets a non-cacheable outcome be PERSISTED
-- (for a bounded-cooldown reuse that throttles retries without ever being trusted indefinitely) while the
-- existing indefinite-hit path (cacheable = 1) is completely unaffected -- see getCachedAiReview's new
-- allowNonCacheable/maxAgeMs option in src/db/repositories.ts.
ALTER TABLE ai_review_cache ADD COLUMN cacheable INTEGER NOT NULL DEFAULT 1;

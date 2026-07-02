-- PR reviews cache invalidation marker (#2537): bumped by a `pull_request_review` webhook
-- (submitted/dismissed/edited) to signal the cached `pull_request_reviews` rows are stale. NULL (the
-- default) means no invalidating event has been recorded, so a subsequent fetchAndStorePullRequestDetails
-- pass can skip the `GET /pulls/{n}/reviews` call when reviews_synced_at already covers it -- byte-identical
-- behavior for every existing row.
ALTER TABLE pull_request_detail_sync_state ADD COLUMN reviews_invalidated_at TEXT;

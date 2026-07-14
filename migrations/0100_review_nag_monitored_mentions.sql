-- Maintainer-mention nag moderation (#label-scoping): extends the existing @loopover review-nag cooldown
-- (review_nag_policy/review_nag_max_pings/review_nag_cooldown_days/review_nag_label) to ALSO throttle a
-- contributor who repeatedly @-mentions a configured maintainer login, counted independently per mentioned
-- login and independently of the @loopover counter. Default '[]' (no logins watched), so existing repos see
-- no behavior change until they opt in.
ALTER TABLE repository_settings ADD COLUMN review_nag_monitored_mentions_json TEXT NOT NULL DEFAULT '[]';

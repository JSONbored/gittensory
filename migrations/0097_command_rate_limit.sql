-- Per-command @gittensory rate limit (#2560, anti-abuse): generalizes the review-nag cooldown's audit-ledger
-- counting pattern to EVERY @gittensory command, not just review-request pings. Independent of and complementary
-- to review-nag (that stays scoped to the thread's own author; this covers any actor invoking any command).
-- Defaults are byte-identical to today: command_rate_limit_policy defaults to 'off' (disabled), so existing
-- repos see no behavior change until they opt in. The AI-cost-bearing commands (ask/blockers/preflight/
-- reviewability/packet/duplicate-check/next-action/repo-fit) get their own tighter default limit than the
-- cheap, cache-only commands (help/miner-context/the maintainer queue-digest commands).
ALTER TABLE repository_settings ADD COLUMN command_rate_limit_policy TEXT NOT NULL DEFAULT 'off';
ALTER TABLE repository_settings ADD COLUMN command_rate_limit_max_per_window INTEGER NOT NULL DEFAULT 20;
ALTER TABLE repository_settings ADD COLUMN command_rate_limit_ai_max_per_window INTEGER NOT NULL DEFAULT 5;
ALTER TABLE repository_settings ADD COLUMN command_rate_limit_window_hours INTEGER NOT NULL DEFAULT 24;

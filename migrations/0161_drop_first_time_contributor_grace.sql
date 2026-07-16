-- loopover#6446/epic #6440: firstTimeContributorGrace (added by migration 0039) is a dead surface -- parsed,
-- clamped, and threaded end-to-end since PR #552, but evaluateGateCheckCore never read it (a deliberate
-- removal per #2411: blocker findings must remain closure/rejection outcomes, not softened for a genuine
-- newcomer). #5321 already spent a PR just disclosing the inertness in the dashboard rather than fixing it.
-- Decision (#6446): delete the dead parsing/manifest/DB/dashboard surface entirely instead of wiring it in,
-- since re-wiring would reintroduce a softened-block exception against the gate's settled one-shot design.
ALTER TABLE repository_settings DROP COLUMN first_time_contributor_grace;

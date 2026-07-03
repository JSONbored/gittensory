-- #selfhost-linked-issue-gate-drift: repository_settings.linked_issue_gate_mode was persisted as 'block'
-- by migration 0023 (its initial ADD COLUMN default) and migration 0025 (a since-superseded "restore"
-- backfill that flipped any 'advisory' row to 'block' for repos with gate_check_mode='enabled'), even
-- though missing a linked issue is only ever supposed to be advisory unless a maintainer explicitly opts
-- into blocking. The application-level fallback (src/db/repositories.ts) and every documented default
-- (.gittensory.yml.example, docs.tuning.tsx, the settings API schema) already say 'advisory' -- only the
-- persisted column value drifted.
--
-- Conservative: only flips a row that is CURRENTLY 'block' AND has require_linked_issue = 0. A row with
-- require_linked_issue = 1 is left untouched -- that boolean is an explicit maintainer opt-in that
-- resolveEffectiveSettings (src/signals/focus-manifest.ts) itself promotes to 'block' whenever the gate
-- would otherwise be 'off' (#797), so a 'block' value paired with require_linked_issue = 1 already reflects
-- an intentional choice, not the drift this migration exists to correct.
UPDATE repository_settings
SET linked_issue_gate_mode = 'advisory'
WHERE linked_issue_gate_mode = 'block'
  AND require_linked_issue = 0;

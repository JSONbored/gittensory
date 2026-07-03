-- #selfhost-linked-issue-gate-drift: repository_settings.linked_issue_gate_mode was persisted as 'block'
-- by migration 0023 (its initial ADD COLUMN default) and migration 0025 (a since-superseded "restore"
-- backfill that flipped any 'advisory' row to 'block' for repos with gate_check_mode='enabled'), even
-- though missing a linked issue is only ever supposed to be advisory unless a maintainer explicitly opts
-- into blocking. The application-level fallback (src/db/repositories.ts) and every documented default
-- (.gittensory.yml.example, docs.tuning.tsx, the settings API schema) already say 'advisory' -- only the
-- persisted column value drifted.
--
-- #gate-review-2727: require_linked_issue = 0 alone does NOT prove drift. linkedIssueGateMode and
-- requireLinkedIssue are independently settable (the maintainer settings UI exposes them as a separate
-- dropdown and toggle; both PUT .../settings and the internal settings route accept linkedIssueGateMode on
-- its own), so a maintainer can genuinely choose 'block' while leaving requireLinkedIssue off. No column on
-- this row records which field a maintainer last touched, so per-field intent can't be recovered.
--
-- What CAN be proven: updated_at is bumped on every write through upsertRepositorySettings
-- (src/db/repositories.ts) -- the only code path that ever changes this row after INSERT -- while
-- created_at is set once, at INSERT, and never touched again. updated_at = created_at therefore means this
-- row has never been written to since it was first created: no settings save, by anyone, has ever happened
-- for this repo. Its 'block' value can only be the byproduct of migration 0023's column default or 0025's
-- blanket flip -- provable drift, not inference from an unrelated field. A row with updated_at > created_at
-- has been through at least one real settings write since creation and is left alone, even though some of
-- those may also be untouched drift this migration can no longer safely reach -- a maintainer stuck with a
-- leftover 'block' default can flip it from the settings UI. Leaving that row alone is the safe failure
-- mode; silently downgrading a real 'block' opt-in to advisory is not.
UPDATE repository_settings
SET linked_issue_gate_mode = 'advisory'
WHERE linked_issue_gate_mode = 'block'
  AND require_linked_issue = 0
  AND updated_at = created_at;

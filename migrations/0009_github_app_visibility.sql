ALTER TABLE repository_settings ADD COLUMN auto_label_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repository_settings ADD COLUMN gittensor_label TEXT NOT NULL DEFAULT 'gittensor';
ALTER TABLE repository_settings ADD COLUMN create_missing_label INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repository_settings ADD COLUMN public_surface TEXT NOT NULL DEFAULT 'comment_and_label';
ALTER TABLE repository_settings ADD COLUMN include_maintainer_authors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repository_settings ADD COLUMN require_linked_issue INTEGER NOT NULL DEFAULT 0;

UPDATE repository_settings
SET
  comment_mode = 'detected_contributors_only',
  check_run_mode = 'off',
  check_run_detail_level = 'minimal',
  auto_label_enabled = 1,
  gittensor_label = 'gittensor',
  create_missing_label = 1,
  public_surface = 'comment_and_label',
  include_maintainer_authors = 0,
  require_linked_issue = 0;

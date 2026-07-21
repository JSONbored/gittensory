-- Content-lane linked-issue deliverable gate (#content-lane-deliverable): off by default -- byte-identical
-- behavior for every existing row. Only meaningful for a repo with a registry content-lane spec resolved
-- (see review/content-lane/spec-resolver.ts). When set to advisory/block, a PR whose primary linked issue's
-- own text names a path matching the resolved spec's entry/provider file pattern must touch at least one
-- matching file; block additionally lets a miss become a gate blocker.
ALTER TABLE repository_settings ADD COLUMN content_lane_deliverable_gate_mode TEXT NOT NULL DEFAULT 'off';

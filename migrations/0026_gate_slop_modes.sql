ALTER TABLE repository_settings ADD COLUMN slop_gate_mode TEXT NOT NULL DEFAULT 'advisory';
ALTER TABLE repository_settings ADD COLUMN slop_gate_max_risk INTEGER;

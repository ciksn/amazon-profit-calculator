SET search_path TO margin;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS owner_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS edit_share_key TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_projects_shared_key
  ON projects(share_key) WHERE share_enabled=TRUE AND share_key<>'';

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_edit_share_key
  ON projects(edit_share_key) WHERE edit_share_key<>'';

-- Adds archiving (records.archive / records.restore) to a database made before it (idempotent).
ALTER TABLE mes.records ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE mes.records ADD COLUMN IF NOT EXISTS archived_by text;

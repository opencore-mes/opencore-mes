-- What an object's access requires (DESIGN.md §9.9) reads the certifications a person holds (§27.9): the query
-- views read them from the viewer's row, as they read their roles. A certification held is found by its
-- person and kind, active and in use.
ALTER TABLE mes.query_context ADD COLUMN IF NOT EXISTS certifications jsonb;
CREATE INDEX IF NOT EXISTS records_certification_person ON mes.records ((data->>'person'))
  WHERE object = 'certification' AND archived_at IS NULL;

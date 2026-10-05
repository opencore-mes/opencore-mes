-- ---- the fitness test (§5.9): the report a change must pass before it is submitted -----------------
-- Idempotent: the schema loads it, and a database made before it is brought up to date with
--   psql -d openmes_poc -f app/mes/db/fitness.sql
-- The latest report on the change, bound to the content hash it tested (so a report on older content
-- is shown as stale, and submitting always tests what it submits).
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS fitness jsonb;

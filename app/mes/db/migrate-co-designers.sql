-- ---- co-designers (§5.3): a draft is its author's, and the co-designers' they name ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.
-- Who else may edit a change in design (designers the author names), and who saved it last (a
-- second editor's save made on an older copy is refused, naming them).
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS co_designers text[] NOT NULL DEFAULT '{}';
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS updated_by text;

-- Everyone who designed a change (§5.3, §5.6): its author, every co-designer ever named, everyone who
-- ever saved it. It only grows: a co-designer taken off the list still designed it, so still neither
-- reviews nor approves it. Filled in for the changes there are (run again, it finds the same people).
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS contributors text[] NOT NULL DEFAULT '{}';
UPDATE mes.change_requests SET contributors = ARRAY(
    SELECT DISTINCT u FROM unnest(contributors || co_designers || ARRAY[author, updated_by]) AS u WHERE u IS NOT NULL ORDER BY u);

-- The draft's own version, which a save names (`seen`): moved by a save of its content and a rename
-- only, never by a fitness run, a review or a signature (those move updated_at, which live views follow).
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS draft_rev integer NOT NULL DEFAULT 0;

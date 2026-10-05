-- ---- rolling a change back (§5.14) ----
-- rollback: on a change that rolls another back: { of, title, hash, restores, retires, republishes,
--           skipped }. `hash` is its content as the platform drafted it: while it is unchanged, the
--           change is what was live before, already reviewed and approved once, and one approval
--           executes it.
-- Idempotent.
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS rollback jsonb;
CREATE INDEX IF NOT EXISTS change_requests_rollback_of ON mes.change_requests ((rollback->>'of')) WHERE rollback IS NOT NULL;

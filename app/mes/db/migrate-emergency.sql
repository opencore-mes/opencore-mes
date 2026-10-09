-- ---- emergency changes (§5.7) ----
-- emergency: on a change its author submitted as an emergency, when the plant cannot wait:
--   { reason, by, at, reviewDays, stage, approved, executedAt, due, review, departments, flagged,
--     overdue, closedAt }.
--   `stage`: approval (one signature, by an approver of any department it touches, executes it) →
--   review (executed; a reviewer, not its author nor its approver, reviews it afterwards) → confirm
--   (each department on its route confirms or flags it) → confirmed | flagged. `due`: by when the
--   review afterwards must be done; past it, the change is flagged overdue (an event, once).
-- Idempotent.
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS emergency jsonb;
-- The emergencies still to be reviewed afterwards: few, read by the inbox, the approvals list and the
-- job that flags the overdue ones.
CREATE INDEX IF NOT EXISTS change_requests_emergency_open ON mes.change_requests ((emergency->>'due'))
    WHERE emergency IS NOT NULL AND emergency->>'stage' IN ('approval', 'review', 'confirm');

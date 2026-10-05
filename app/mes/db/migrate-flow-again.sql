-- ---- plans that set off again, and by a date (§32.5a) ----
-- One run of a plan at a time per template and record (its own sub flows aside): a plan whose start says
-- `again` sets off again only once the last has ended, and two instances checking the same due date at
-- once start it once. Idempotent: a migration (migrate.mjs) and the reset both run it.
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_one_plan ON mes.flow_runs (flow, subject_id) WHERE kind = 'plan' AND parent_id IS NULL AND state <> 'ended';

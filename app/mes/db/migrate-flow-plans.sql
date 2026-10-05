-- ---- flow templates' plans (§32, phase 2): what a run waits for, its sub flows, its files ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.
-- A run waiting at a wait, a manual decision, an input screen or a sub flow: what for (`waiting`: its
-- kind, who acts, its mode; a sub flow's child run), and when a wait's time is up (`due_at`). A sub
-- flow's run names the run it was started from (`parent_id`).
ALTER TABLE mes.flow_runs ADD COLUMN IF NOT EXISTS waiting jsonb;
ALTER TABLE mes.flow_runs ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE mes.flow_runs ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES mes.flow_runs (id);
CREATE INDEX IF NOT EXISTS flow_runs_due ON mes.flow_runs (due_at) WHERE state = 'running' AND due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS flow_runs_subject ON mes.flow_runs (subject_id, flow);
CREATE INDEX IF NOT EXISTS flow_runs_waiting ON mes.flow_runs ((waiting->>'kind')) WHERE state = 'running' AND waiting IS NOT NULL;

-- What an input screen collected as a file or an image, kept with its run (its context holds the id).
CREATE TABLE IF NOT EXISTS mes.flow_files (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id  uuid NOT NULL REFERENCES mes.flow_runs (id),
  node    text NOT NULL,
  field   text NOT NULL,
  name    text NOT NULL,
  type    text NOT NULL,
  size    integer NOT NULL,
  data    bytea NOT NULL,
  by      text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_files_run ON mes.flow_files (run_id);

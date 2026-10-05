-- ---- flow templates (§32): routes and out-of-control action plans, as a design element (content.flows),
-- and their runs ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.
CREATE TABLE IF NOT EXISTS mes.flows (
  name       text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('published', 'superseded', 'retired')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS flows_one_published ON mes.flows (name) WHERE status = 'published';

-- A run: one traveler's way through one version of a route (or, later, one plan set off once). Its
-- position is here; `participants` are its records by name, `context` its values (the template's
-- initial ones, and what its scripts and input screens put there).
CREATE TABLE IF NOT EXISTS mes.flow_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow           text NOT NULL,
  version        integer NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('route', 'plan')),
  subject_object text NOT NULL,
  subject_id     uuid NOT NULL,
  participants   jsonb NOT NULL DEFAULT '{}',
  context        jsonb NOT NULL DEFAULT '{}',
  node           text,
  state          text NOT NULL CHECK (state IN ('running', 'stopped', 'ended')),
  reason         text,
  outcome        text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);
ALTER TABLE mes.flow_runs ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}';
-- One route under way per traveler: held by migrate-sub-routes.sql (one at the top; its sub routes' runs
-- are its children).
CREATE INDEX IF NOT EXISTS flow_runs_by_flow ON mes.flow_runs (flow, state);

-- Its way: each node entered, by what (a transaction, a start, a step moved off its wires) and on whose behalf.
CREATE TABLE IF NOT EXISTS mes.flow_steps (
  run_id   uuid NOT NULL REFERENCES mes.flow_runs (id),
  seq      integer NOT NULL,
  node     text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  by       text,
  via      text,
  note     text,
  PRIMARY KEY (run_id, seq)
);

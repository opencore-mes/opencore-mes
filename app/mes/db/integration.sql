-- ---- integration (§15.2): services and connections as design elements, and the trigger outbox ----
-- Idempotent: the schema loads it, and a database made before it is brought up to date with
--   psql -d openmes_poc -f app/mes/db/integration.sql

-- A connection: an outside system (its address, how the MES proves who it is, the requests allowed).
-- Its secret is named here and set on the server; its value is never part of a design.
CREATE TABLE IF NOT EXISTS mes.connections (
  name       text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('published', 'superseded')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS connections_one_published ON mes.connections (name) WHERE status = 'published';

-- A service: its script (mes.scripts, the same name), who may call it, what sets it off, what it reaches.
CREATE TABLE IF NOT EXISTS mes.services (
  name       text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('published', 'superseded')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS services_one_published ON mes.services (name) WHERE status = 'published';

-- What a record event set off: written in the event's own transaction (so a committed release always
-- sets off its trigger, and a rolled-back one never does), run after by the outbox worker, retried
-- when the outside system is down. `chain` names the services that led here, so a service never sets
-- itself off and a chain stops.
CREATE TABLE IF NOT EXISTS mes.integration_outbox (
  id          bigserial PRIMARY KEY,
  service     text NOT NULL,
  event       jsonb NOT NULL,
  run_as      text NOT NULL,
  chain       jsonb NOT NULL DEFAULT '[]',
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'retry', 'done', 'rejected', 'dead')),
  attempts    integer NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
CREATE INDEX IF NOT EXISTS integration_outbox_due ON mes.integration_outbox (next_at) WHERE state IN ('pending', 'running', 'retry');

ALTER TABLE mes.change_requests ALTER COLUMN content SET DEFAULT '{"definitions": {}, "scripts": {}, "services": {}, "connections": {}}';
ALTER TABLE mes.change_requests ALTER COLUMN base SET DEFAULT '{"definitions": {}, "scripts": {}, "services": {}, "connections": {}}';

-- Who a service acted for: its caller, or the event that set it off (an audit row's actor is then
-- the service's own identity, service:<name>).
ALTER TABLE mes.audit_log ADD COLUMN IF NOT EXISTS on_behalf_of text;

-- ---- schedules and nodes (§15.3) --------------------------------------------------------------
-- A scheduled run is an outbox row like a trigger's, keyed by its service and the time it was due:
-- however many nodes plan it, it is planned once. `run_on` keeps a row to the nodes with that tag.
ALTER TABLE mes.integration_outbox ADD COLUMN IF NOT EXISTS run_on text;
ALTER TABLE mes.integration_outbox ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS integration_outbox_scheduled ON mes.integration_outbox (service, scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS integration_outbox_service ON mes.integration_outbox (service, id DESC);

-- Each scheduled service's state: how far it has been planned, whether it is paused (operations, not
-- design), and how its runs went. `last_output` is the last successful run's output, which the next
-- run reads (ctx.event.previous), so a script keeps its cursor in its own output.
CREATE TABLE IF NOT EXISTS mes.schedule_state (
  service          text PRIMARY KEY,
  last_planned_at  timestamptz,
  paused           boolean NOT NULL DEFAULT false,
  paused_by        text,
  paused_at        timestamptz,
  last_run_at      timestamptz,
  last_state       text,
  last_error       text,
  last_ok_at       timestamptz,
  last_output      jsonb,
  runs_ok          integer NOT NULL DEFAULT 0,
  runs_failed      integer NOT NULL DEFAULT 0,
  missed           integer NOT NULL DEFAULT 0,
  skipped          integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The nodes (instances) running this plant, each saying what it does: whether it plans schedules,
-- whether it runs the outbox, and its tags (a service's `runOn` names one). A node that has not been
-- seen for a while is gone.
CREATE TABLE IF NOT EXISTS mes.nodes (
  name        text PRIMARY KEY,
  tags        text[] NOT NULL DEFAULT '{}',
  scheduler   boolean NOT NULL,
  outbox      boolean NOT NULL,
  build       text,
  started_at  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL
);

-- The monitor reads the services' calls of the last day from the audit trail.
CREATE INDEX IF NOT EXISTS audit_log_service_at ON mes.audit_log (at) WHERE object = '$service';

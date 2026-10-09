-- OpenCore MES proof of concept: the database (DESIGN.md §7).
-- Everything about a plant's objects is data: definitions, scripts, records. Nothing here names a
-- plant object except the seed.

DROP SCHEMA IF EXISTS mes CASCADE;
CREATE SCHEMA mes;
SET search_path = mes;

-- ---- identity (§8) -------------------------------------------------------------------------
CREATE TABLE users (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE groups (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'group' CHECK (kind IN ('group', 'department'))
);

CREATE TABLE group_members (
  group_id   text NOT NULL REFERENCES groups(id),
  user_id    text NOT NULL REFERENCES users(id),
  PRIMARY KEY (group_id, user_id)
);

-- A role is declared by an object's definition; an assignment gives it to a user or a group.
CREATE TABLE assignments (
  id           bigserial PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('user', 'group')),
  subject_id   text NOT NULL,
  object       text NOT NULL,
  role         text NOT NULL,
  UNIQUE (subject_kind, subject_id, object, role)
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- The page its desktop opens (§6.8), found at sign-in by the address it came from; its label.
  home        text,
  home_label  text
);

-- Personal preferences: favorites, open tabs (§10.1). Not design changes.
CREATE TABLE user_prefs (
  user_id  text PRIMARY KEY REFERENCES users(id),
  prefs    jsonb NOT NULL DEFAULT '{}'
);

-- ---- metadata (§6) -----------------------------------------------------------------------
CREATE TABLE definitions (
  object     text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('draft', 'in_review', 'approved', 'published', 'superseded')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object, version)
);
CREATE UNIQUE INDEX definitions_one_published ON definitions (object) WHERE status = 'published';

-- Rule scripts (§12): one function per name, versioned.
CREATE TABLE scripts (
  name       text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('draft', 'in_review', 'approved', 'published', 'superseded')),
  source     text NOT NULL,
  tests      jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE UNIQUE INDEX scripts_one_published ON scripts (name) WHERE status = 'published';

-- ---- records (§7.1): fixed columns + JSONB, one partition per object ---------------------------
CREATE TABLE records (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  object       text        NOT NULL,
  def_version  integer     NOT NULL,
  type         text,
  state        text        NOT NULL,
  data         jsonb       NOT NULL,
  row_version  bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text        NOT NULL,
  -- Archived (§11.1 records.archive): out of the lists, read-only, kept. Never deleted (Part 11).
  archived_at  timestamptz,
  archived_by  text,
  PRIMARY KEY (object, id)
) PARTITION BY LIST (object);

-- ---- audit (§7.3): append-only, hash-chained ----------------------------------------------
CREATE TABLE audit_log (
  seq          bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor        text NOT NULL,
  object       text NOT NULL,
  record_id    uuid,
  def_version  integer,
  action       text NOT NULL,
  before       jsonb,
  after        jsonb,
  rules        jsonb,
  prev_hash    text NOT NULL,
  hash         text NOT NULL,
  chain        smallint NOT NULL DEFAULT 0   -- which of the chains (§7.3): the record's
);
CREATE INDEX audit_log_chain_seq ON audit_log (chain, seq);

-- The chains' heads: one row a chain, locked by whoever links an entry to it (migrate-audit-chains.sql).
CREATE TABLE audit_head (
  chain  smallint PRIMARY KEY,
  hash   text NOT NULL
);
INSERT INTO audit_head (chain, hash) SELECT c, repeat('0', 64) FROM generate_series(0, 15) c;

CREATE FUNCTION audit_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();
-- TRUNCATE fires no row trigger: refused by its own.
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_is_append_only();

-- ---- queries (§23): views of the objects, and the role a viewer's SQL runs as ---------------------
-- q holds one view per object (q.lot, …) and its stays (q.lot_stays), generated from the published
-- definitions with their policies compiled in (query.js). mes_query may read those views and nothing
-- else; the app's user becomes it for the length of one query.
CREATE SCHEMA IF NOT EXISTS q;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mes_query') THEN CREATE ROLE mes_query NOLOGIN; END IF;
END $$;
GRANT mes_query TO CURRENT_USER;
GRANT USAGE ON SCHEMA q TO mes_query;
-- Who is viewing, for the length of one query's transaction; a view reads the row of its own
-- transaction, and mes_query cannot read or write this table.
CREATE TABLE IF NOT EXISTS mes.query_context (
  txid     bigint PRIMARY KEY,
  user_id  text   NOT NULL,
  roles    jsonb  NOT NULL,
  certifications jsonb   -- what they hold (§27.9): what an object's access requires reads it (§9.9)
);
-- Which definitions the views were last built from.
CREATE TABLE IF NOT EXISTS mes.query_views (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  signature  text NOT NULL,
  built_at   timestamptz NOT NULL
);

-- ---- analytics (§22): each stay of a record in a state ------------------------------------------
-- Written in the transaction of every create, transition, archive and restore (services.js), or
-- rebuilt from the audit trail (analytics.js). `dims` holds the object's analytics dimensions as they
-- were when the stay began.
CREATE TABLE IF NOT EXISTS mes.state_intervals (
  id            bigserial   PRIMARY KEY,
  object        text        NOT NULL,
  record_id     uuid        NOT NULL,
  state         text        NOT NULL,
  entered_at    timestamptz NOT NULL,
  entered_by    text        NOT NULL,
  enter_action  text        NOT NULL,
  left_at       timestamptz,
  left_by       text,
  leave_action  text,
  dims          jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS state_intervals_record ON mes.state_intervals (object, record_id, entered_at);
CREATE INDEX IF NOT EXISTS state_intervals_entered ON mes.state_intervals (object, state, entered_at);
CREATE INDEX IF NOT EXISTS state_intervals_left ON mes.state_intervals (object, left_at) WHERE left_at IS NOT NULL;
-- At most one open stay per record: a transition closes one and opens the next.
CREATE UNIQUE INDEX IF NOT EXISTS state_intervals_one_open ON mes.state_intervals (object, record_id) WHERE left_at IS NULL;

-- ---- the event log (§7.6): what happened to the system, copied from each instance's file ----------
-- Each instance writes its events to a file first (the database may be the thing that is down), with
-- a sequence and a hash chain of its own; the forwarder copies them here, keyed by (instance, seq).
CREATE TABLE event_log (
  instance     text        NOT NULL,
  seq          bigint      NOT NULL,
  at           timestamptz NOT NULL,
  build        text,
  kind         text        NOT NULL,
  severity     text        NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  incident     text,
  message      text        NOT NULL,
  details      jsonb,
  prev_hash    text        NOT NULL,
  hash         text        NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance, seq)
);
CREATE INDEX event_log_at ON event_log (at DESC);
CREATE INDEX event_log_incident ON event_log (incident) WHERE incident IS NOT NULL;

CREATE FUNCTION event_log_is_append_only() RETURNS trigger AS $$
BEGIN
  -- The retention purge alone (§27.8, migrate-retention.sql: the same body, whichever file runs last) may
  -- delete, and only rows past a year.
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' AND current_setting('mes.retention_purge', true) = 'on'
     AND OLD.at < now() - interval '365 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'event_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_log_no_update BEFORE UPDATE OR DELETE ON event_log
FOR EACH ROW EXECUTE FUNCTION event_log_is_append_only();
CREATE TRIGGER event_log_no_truncate BEFORE TRUNCATE ON event_log
FOR EACH STATEMENT EXECUTE FUNCTION event_log_is_append_only();

-- Idempotency (§11.1): a retried write returns the first answer.
CREATE TABLE idempotency (
  key        text NOT NULL,
  user_id    text NOT NULL,
  result     jsonb NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  -- A key is its sender's: one person's never answers, or blocks, another's.
  PRIMARY KEY (user_id, key)
);

-- ---- the change lifecycle (§5): design -> review -> approval -> execution ------------------------
-- A department's representatives approve for it (§5.6), in steps (Specialist, then Manager): each
-- belongs to one step.
CREATE TABLE department_reps (
  group_id  text NOT NULL REFERENCES groups(id),
  user_id   text NOT NULL REFERENCES users(id),
  step      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  reason        text NOT NULL DEFAULT '',
  state         text NOT NULL CHECK (state IN ('design', 'review', 'approval', 'executed', 'failed', 'rejected', 'withdrawn')),
  author        text NOT NULL REFERENCES users(id),
  -- What it changes: { definitions: { object: body }, scripts: { name: source } }, and the live
  -- versions it was drafted against, so execution can refuse a change whose base moved (§5.3).
  content       jsonb NOT NULL DEFAULT '{"definitions": {}, "scripts": {}}',
  base          jsonb NOT NULL DEFAULT '{"definitions": {}, "scripts": {}}',
  content_hash  text,
  footprint     jsonb,
  route         jsonb,
  reviewer      text REFERENCES users(id),
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  executed_at   timestamptz,
  outcome       jsonb
);

-- One signed approval (or rejection) per department, step and change, bound to the content hash (§5.3).
CREATE TABLE approvals (
  change_id     uuid NOT NULL REFERENCES change_requests(id),
  department    text NOT NULL REFERENCES groups(id),
  step          integer NOT NULL DEFAULT 1,
  user_id       text NOT NULL REFERENCES users(id),
  decision      text NOT NULL CHECK (decision IN ('approve', 'reject')),
  meaning       text NOT NULL,
  note          text NOT NULL DEFAULT '',
  content_hash  text NOT NULL,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (change_id, department, step)
);

-- ---- presence (§10.1): who has a record open, shared by every instance ------------------------
-- UNLOGGED: lost on a crash, which is what presence should be; and never replicated, so it is read
-- on the primary.
CREATE UNLOGGED TABLE presence (
  object   text NOT NULL,
  id       uuid NOT NULL,
  user_id  text NOT NULL,
  name     text NOT NULL,
  editing  boolean NOT NULL DEFAULT false,
  since    timestamptz NOT NULL DEFAULT now(),
  seen     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object, id, user_id)
);

-- ---- the AI design API (§16): tokens and provenance -------------------------------------------
-- A token lets an AI (Claude, or any other) work in the designer for one person, with scopes that
-- never include review or approval. Only its hash is kept; the token is shown once.
CREATE TABLE api_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  agent       text NOT NULL DEFAULT '',
  scopes      text[] NOT NULL,
  hash        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used   timestamptz,
  revoked_at  timestamptz
);

-- What an AI drafted in each change request, so reviewers see it (§16.1: "drafted by AI").
ALTER TABLE change_requests ADD COLUMN ai_edits jsonb NOT NULL DEFAULT '[]';

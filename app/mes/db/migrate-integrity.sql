-- ---- the data integrity review (§7.7, COMPLIANCE.md G16) ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.

-- Each record's seal, written by the platform's own writes (server/integrity.js sealOfRecord).
ALTER TABLE mes.records ADD COLUMN IF NOT EXISTS seal text;

-- The tripwire: a write to a record that did not come through the platform (its data, state, type, version or
-- archive changed while its seal did not; a row added without one; a row removed), kept with who and where from.
CREATE TABLE IF NOT EXISTS mes.integrity_tripwire (
  seq         bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  op          text NOT NULL,
  object      text NOT NULL,
  record_id   uuid,
  ref         text,                 -- a design's or an access row's key (the tables below)
  db_user     text NOT NULL,
  client_addr text,
  app_name    text,
  old_row     jsonb,
  new_row     jsonb
);
CREATE OR REPLACE FUNCTION mes.integrity_tripwire_fn() RETURNS trigger AS $$
BEGIN
  -- The platform's own reseal (a design's execution converting stored values, an erasure): said so for its
  -- transaction alone. Whoever sets it by hand is still found by the seal.
  IF current_setting('mes.integrity_reseal', true) = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' AND NEW.seal IS NOT NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.seal IS DISTINCT FROM OLD.seal
      OR (NEW.data, NEW.state, NEW.type, NEW.row_version, NEW.archived_by) IS NOT DISTINCT FROM (OLD.data, OLD.state, OLD.type, OLD.row_version, OLD.archived_by)) THEN
    RETURN NULL;
  END IF;
  INSERT INTO mes.integrity_tripwire (op, object, record_id, db_user, client_addr, app_name, old_row, new_row)
  VALUES (TG_OP, COALESCE(NEW.object, OLD.object), COALESCE(NEW.id, OLD.id), session_user, inet_client_addr()::text,
          current_setting('application_name', true),
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END, CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS records_integrity_tripwire ON mes.records;
CREATE TRIGGER records_integrity_tripwire AFTER INSERT OR UPDATE OR DELETE ON mes.records
FOR EACH ROW EXECUTE FUNCTION mes.integrity_tripwire_fn();

-- The same tripwire on what decides behaviour and access: the designs' tables and the people, groups and roles.
-- Only the platform writes them (a change executing, a migration, the demo's guests, the reset), and says so;
-- any other write is kept, so resealing them later (the next change) never hides it. TG_ARGV: the row's key.
CREATE OR REPLACE FUNCTION mes.integrity_tripwire_table_fn() RETURNS trigger AS $$
DECLARE r jsonb;
BEGIN
  IF current_setting('mes.integrity_reseal', true) = 'on' THEN RETURN NULL; END IF;
  r := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  INSERT INTO mes.integrity_tripwire (op, object, ref, db_user, client_addr, app_name, old_row, new_row)
  VALUES (TG_OP, TG_TABLE_NAME, array_to_string(ARRAY(SELECT r->>k FROM unnest(TG_ARGV) AS k), ':'), session_user,
          inet_client_addr()::text, current_setting('application_name', true),
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END, CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('users', 'id'), ('groups', 'id'), ('group_members', 'group_id,user_id'), ('department_reps', 'group_id,user_id'),
      ('assignments', 'subject_kind,subject_id,object,role'), ('organization', 'version'), ('definitions', 'object,version'),
      ('scripts', 'name,version'), ('services', 'name,version'), ('connections', 'name,version'), ('transactions', 'name,version'),
      ('screens', 'name,version'), ('flows', 'name,version'), ('layouts', 'name,version'), ('queries', 'name,version'),
      ('elements', 'name,version')) AS v(tab, cols)
  LOOP
    IF to_regclass('mes.' || t.tab) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON mes.%I', t.tab || '_integrity_tripwire', t.tab);
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON mes.%I FOR EACH ROW EXECUTE FUNCTION mes.integrity_tripwire_table_fn(%s)',
                     t.tab || '_integrity_tripwire', t.tab, (SELECT string_agg(quote_literal(c), ', ') FROM unnest(string_to_array(t.cols, ',')) AS c));
    END IF;
  END LOOP;
END $$;

-- The seals of what decides behaviour and access: each published design and script, and the people, groups
-- and roles as one (kind 'access'), written by the platform when a change executes.
CREATE TABLE IF NOT EXISTS mes.integrity_seals (
  kind      text NOT NULL,
  name      text NOT NULL,
  version   integer,
  seal      text NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, name)
);

-- What the scan found: one open finding per thing and problem; closed only with a non-conformance report.
CREATE TABLE IF NOT EXISTS mes.integrity_findings (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  found_at  timestamptz NOT NULL DEFAULT now(),
  kind      text NOT NULL,          -- record | design | access
  object    text NOT NULL,          -- the record's object, or the design's kind
  ref       text NOT NULL,          -- the record's id, or the design's name
  problem   text NOT NULL,          -- changed | unsealed | replaced | removed
  detail    jsonb,
  state     text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  closed_at timestamptz,
  closed_by text,
  report    jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS integrity_findings_open ON mes.integrity_findings (kind, object, ref, problem) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS integrity_findings_found ON mes.integrity_findings (found_at DESC);

-- Where the review stands: the baseline (from when integrity is proven), the scans.
CREATE TABLE IF NOT EXISTS mes.integrity_state (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  baseline_at  timestamptz,
  baseline_by  text,
  key_id       text,                -- which key the seals were made with (server/integrity.js keyId), 'none' unkeyed
  key_from_seq bigint NOT NULL DEFAULT 0,  -- the audit trail's seals from here on were made with it
  last_scan_at timestamptz,
  last_full_at timestamptz,
  tripwire_seq bigint NOT NULL DEFAULT 0,
  scanned      integer NOT NULL DEFAULT 0
);
INSERT INTO mes.integrity_state (id) VALUES (true) ON CONFLICT DO NOTHING;

-- The periodic review (EU GMP Annex 11 §11): a reviewer signs that a period was reviewed.
CREATE TABLE IF NOT EXISTS mes.integrity_reviews (
  id        bigserial PRIMARY KEY,
  from_at   timestamptz NOT NULL,
  to_at     timestamptz NOT NULL,
  note      text NOT NULL,
  open      integer NOT NULL,
  closed    integer NOT NULL,
  by        text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  signature jsonb
);

-- The last audited seal of a record, read per batch by the scan.
-- (On a database whose trail is protected, ops/db/protect-audit.sql, mes.audit_log is a view: its administrator
-- indexes audit.audit_log the same way.)
DO $$ BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = 'mes.audit_log'::regclass) IN ('r', 'p') THEN
    CREATE INDEX IF NOT EXISTS audit_log_record_seq ON mes.audit_log (record_id, seq DESC) WHERE record_id IS NOT NULL;
  END IF;
END $$;

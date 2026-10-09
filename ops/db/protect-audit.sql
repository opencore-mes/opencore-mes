-- The audit trail kept out of the application's reach (COMPLIANCE.md G3, DESIGN.md §7.3). By default the
-- application's own database role owns mes.audit_log, so it could switch off the triggers that refuse changes
-- to it, or drop it. Run once by a database administrator, this moves the trail and its head into a schema
-- `audit` owned by a role nobody signs in as (mes_audit), and leaves in their place two views the application
-- writes through: it may add to the trail and read it, and move its head, but no longer change, delete,
-- truncate or drop an entry, nor switch a trigger off. The views are owned by mes_audit too; the application,
-- owning the schema mes, could drop one, which stops it writing (every write is refused) and changes nothing
-- already written: verify-audit reads audit.audit_log itself, once it exists.
--
-- Safe to run again, and run again after an upgrade whose migration adds a column to the trail (a view keeps
-- the columns it was made with). A migration that alters the table itself (ALTER TABLE mes.audit_log …) fails
-- at start on a protected database, saying so: the administrator runs it, as the owner, then this.
--
--   psql -v app=opencore -d opencore_mes_demo -f ops/db/protect-audit.sql      (as postgres, or the database's owner)
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mes_audit') THEN CREATE ROLE mes_audit NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION mes_audit;

-- The tables, their sequence, indexes and triggers, and the trigger's function: moved, once.
DO $$ BEGIN
  IF to_regclass('audit.audit_log') IS NULL THEN
    ALTER TABLE mes.audit_log SET SCHEMA audit;
    ALTER TABLE mes.audit_head SET SCHEMA audit;
    ALTER FUNCTION mes.audit_is_append_only() SET SCHEMA audit;
  END IF;
END $$;
ALTER TABLE audit.audit_log OWNER TO mes_audit;
ALTER TABLE audit.audit_head OWNER TO mes_audit;
ALTER FUNCTION audit.audit_is_append_only() OWNER TO mes_audit;
REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM PUBLIC;

-- Where the application reads and writes, as before. Inserted rows take the table's defaults (seq, at).
DROP VIEW IF EXISTS mes.audit_log;
DROP VIEW IF EXISTS mes.audit_head;
CREATE VIEW mes.audit_log AS SELECT * FROM audit.audit_log;
CREATE VIEW mes.audit_head AS SELECT * FROM audit.audit_head;
ALTER VIEW mes.audit_log OWNER TO mes_audit;
ALTER VIEW mes.audit_head OWNER TO mes_audit;

-- What the application may do: add to the trail and read it; read the head, lock it and move it on.
REVOKE ALL ON mes.audit_log, mes.audit_head FROM :"app";
GRANT SELECT, INSERT ON mes.audit_log TO :"app";
GRANT SELECT, UPDATE ON mes.audit_head TO :"app";
GRANT USAGE ON SCHEMA audit TO :"app";
GRANT SELECT ON audit.audit_log, audit.audit_head TO :"app";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO :"app";
COMMIT;
\echo 'audit trail protected: the application adds to it and reads it, and can no longer change it'

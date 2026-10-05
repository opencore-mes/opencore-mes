-- The trails are append-only against TRUNCATE too (idempotent): the row triggers refuse UPDATE and
-- DELETE, and TRUNCATE fires no row trigger, so it emptied either table without a word.
DROP TRIGGER IF EXISTS audit_no_truncate ON mes.audit_log;
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON mes.audit_log
FOR EACH STATEMENT EXECUTE FUNCTION mes.audit_is_append_only();
DROP TRIGGER IF EXISTS event_log_no_truncate ON mes.event_log;
CREATE TRIGGER event_log_no_truncate BEFORE TRUNCATE ON mes.event_log
FOR EACH STATEMENT EXECUTE FUNCTION mes.event_log_is_append_only();

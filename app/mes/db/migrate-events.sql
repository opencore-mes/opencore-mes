-- Adds the event log (§7.6) to a database made before it (idempotent).
CREATE TABLE IF NOT EXISTS mes.event_log (
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
CREATE INDEX IF NOT EXISTS event_log_at ON mes.event_log (at DESC);
CREATE INDEX IF NOT EXISTS event_log_incident ON mes.event_log (incident) WHERE incident IS NOT NULL;
CREATE OR REPLACE FUNCTION mes.event_log_is_append_only() RETURNS trigger AS $$
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
DROP TRIGGER IF EXISTS event_log_no_update ON mes.event_log;
CREATE TRIGGER event_log_no_update BEFORE UPDATE OR DELETE ON mes.event_log
FOR EACH ROW EXECUTE FUNCTION mes.event_log_is_append_only();

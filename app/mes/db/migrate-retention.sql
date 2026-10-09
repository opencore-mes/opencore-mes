-- ---- data retention (§27.8; COMPLIANCE.md G11): how long each kind of data is kept, and its purge ----
-- The periods are part of the organization (mes.organization's body, `retention`), approved by governance.
-- Idempotent: safe to run again.

-- Each run of the purge: when, by whom (platform:retention, or the privacy officer who ran it now), the
-- periods it applied (days per kind, null for forever) and what it removed per kind: numbers, never
-- contents. `more`: a kind had more past its period than one run removes; the next run goes on.
CREATE TABLE IF NOT EXISTS mes.retention_runs (
    id        bigserial PRIMARY KEY,
    at        timestamptz NOT NULL DEFAULT now(),
    by        text NOT NULL,
    instance  text,
    periods   jsonb NOT NULL,
    counts    jsonb NOT NULL,
    more      boolean NOT NULL DEFAULT false,
    error     text
);
CREATE INDEX IF NOT EXISTS retention_runs_at ON mes.retention_runs (at DESC);

-- What the purge looks for, found without reading the whole table.
CREATE INDEX IF NOT EXISTS idempotency_at ON mes.idempotency (at);
CREATE INDEX IF NOT EXISTS integration_outbox_finished ON mes.integration_outbox ((coalesce(done_at, created_at))) WHERE state IN ('done', 'rejected', 'dead');

-- The event log's copy stays append-only (§7.6), but for the purge: a row past a year, deleted in a
-- transaction that says it is the purge (SET LOCAL mes.retention_purge = 'on'). The year is held here
-- too, so no period set by mistake takes recent events. TRUNCATE, UPDATE and any other DELETE are refused.
CREATE OR REPLACE FUNCTION mes.event_log_is_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' AND current_setting('mes.retention_purge', true) = 'on'
     AND OLD.at < now() - interval '365 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'event_log is append-only';
END;
$$ LANGUAGE plpgsql;

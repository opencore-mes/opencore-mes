-- Adds state intervals (analytics, §22) to a database made before them (idempotent). Then fill them
-- from the audit trail: node app/mes/db/rebuild-intervals.mjs
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

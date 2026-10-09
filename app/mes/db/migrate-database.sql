-- The Database area (DESIGN.md §38): the platform's statements counted per hour and instance (sql-stats.js),
-- never their parameter values; and the indexes the area built, with who asked, why, and when they were
-- ready (an index's effect is the hours before it against the hours after). Safe to run again.
CREATE TABLE IF NOT EXISTS mes.sql_stats (
  hour      timestamptz NOT NULL,
  key       text NOT NULL,
  instance  text NOT NULL,
  text      text NOT NULL,
  sample    text,
  calls     bigint NOT NULL DEFAULT 0,
  total_ms  double precision NOT NULL DEFAULT 0,
  max_ms    double precision NOT NULL DEFAULT 0,
  rows      bigint NOT NULL DEFAULT 0,
  errors    bigint NOT NULL DEFAULT 0,
  replica   bigint NOT NULL DEFAULT 0,
  sources   jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (hour, key, instance)
);
CREATE INDEX IF NOT EXISTS sql_stats_key ON mes.sql_stats (key, hour);

CREATE TABLE IF NOT EXISTS mes.db_indexes (
  name        text PRIMARY KEY,
  spec        jsonb NOT NULL,
  definition  text NOT NULL,
  why         text NOT NULL,
  state       text NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'ready', 'failed', 'dropped')),
  error       text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ready_at    timestamptz,
  dropped_by  text,
  dropped_at  timestamptz,
  statements  text[] NOT NULL DEFAULT '{}'
);

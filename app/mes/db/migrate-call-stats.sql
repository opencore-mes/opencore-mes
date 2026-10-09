-- The platform's calls counted per hour, instance, kind, name and channel (call-stats.js, DESIGN.md §38.1): how
-- often, how long (in all, the slowest, in fixed buckets for percentiles), answered, refused or failed, who
-- called (the busiest, the rest as "others") and why refusals were (their codes); never an input or a value.
-- Kept 35 days. Safe to run again.
CREATE TABLE IF NOT EXISTS mes.call_stats (
  hour      timestamptz NOT NULL,
  kind      text NOT NULL,
  name      text NOT NULL,
  channel   text NOT NULL,
  instance  text NOT NULL,
  calls     bigint NOT NULL DEFAULT 0,
  ok        bigint NOT NULL DEFAULT 0,
  refused   bigint NOT NULL DEFAULT 0,
  failed    bigint NOT NULL DEFAULT 0,
  total_ms  double precision NOT NULL DEFAULT 0,
  max_ms    double precision NOT NULL DEFAULT 0,
  buckets   bigint[] NOT NULL DEFAULT '{}',
  callers   jsonb NOT NULL DEFAULT '{}',
  codes     jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (hour, kind, name, channel, instance)
);
CREATE INDEX IF NOT EXISTS call_stats_name ON mes.call_stats (kind, name, hour);

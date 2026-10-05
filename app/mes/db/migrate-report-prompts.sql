-- ---- kept prompts of the analytics copilot (§34.7) ----
-- What a person asks the copilot, kept under a title: asked again as it is or changed, and, with a
-- schedule, asked by the clock as that person. Each generation is kept as a report of theirs (a
-- record of Report, through the record services); this table holds the asking, not the reports.
-- Idempotent: a migration (migrate.mjs) and the reset both run it.
CREATE TABLE IF NOT EXISTS mes.report_prompts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner       text NOT NULL,
  title       text NOT NULL,
  prompt      text NOT NULL,
  layout      text,
  schedule    jsonb,
  next_at     timestamptz,
  running     boolean NOT NULL DEFAULT false,
  started_at  timestamptz,
  last_at     timestamptz,
  last_report uuid,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_prompts_owner ON mes.report_prompts (owner, title);
CREATE INDEX IF NOT EXISTS report_prompts_due ON mes.report_prompts (next_at) WHERE next_at IS NOT NULL;
-- What the reports it generates are filed under (§34.8).
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS tags text;

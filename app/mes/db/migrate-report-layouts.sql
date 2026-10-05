-- ---- report layouts (§34.5): how an AI report is laid out, as a design element ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.
CREATE TABLE IF NOT EXISTS mes.layouts (
  name       text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('published', 'superseded', 'retired')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS layouts_one_published ON mes.layouts (name) WHERE status = 'published';
-- The layout a person's conversation with the analytics copilot draws on.
ALTER TABLE mes.analyst_conversations ADD COLUMN IF NOT EXISTS layout text;

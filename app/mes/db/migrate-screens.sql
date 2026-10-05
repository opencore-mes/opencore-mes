-- ---- screens (§26): pages of fixed building blocks, as a design element ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.
CREATE TABLE IF NOT EXISTS mes.screens (
  name       text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('published', 'superseded')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS screens_one_published ON mes.screens (name) WHERE status = 'published';

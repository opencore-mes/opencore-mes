-- ---- design elements of a kind a suite adds (§30.11) ----
-- One table for every suite's kinds: a body names its kind ("<suite>.<kind>"). Versioned and
-- published like the core's elements; they stay here, as they are, when the suite is removed.
-- Idempotent: a migration (migrate.mjs) and the reset both run it.
CREATE TABLE IF NOT EXISTS mes.elements (
  name       text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('published', 'superseded', 'retired')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS elements_one_published ON mes.elements (name) WHERE status = 'published';

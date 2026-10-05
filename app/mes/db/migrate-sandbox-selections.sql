-- ---- saved sandbox selections (§5.11) ----
-- A designer's named sets of the records a sandbox starts with, to switch between, save, rename and
-- delete: their own, kept across changes and sessions. Not designs (no lifecycle, nothing live reads
-- them), so a person deletes theirs outright. Idempotent: a migration (migrate.mjs) and the reset both run it.
CREATE TABLE IF NOT EXISTS mes.sandbox_selections (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner      text NOT NULL REFERENCES mes.users(id),
    name       text NOT NULL,
    records    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner, name)
);

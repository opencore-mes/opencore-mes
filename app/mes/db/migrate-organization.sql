-- ---- the organization (§5.6, §8): people, departments and their approval steps, as a design element ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.

-- A department approves in steps (Specialist, then Manager): each representative belongs to one step.
ALTER TABLE mes.department_reps ADD COLUMN IF NOT EXISTS step integer NOT NULL DEFAULT 1;

-- One signature per department, step and change.
ALTER TABLE mes.approvals ADD COLUMN IF NOT EXISTS step integer NOT NULL DEFAULT 1;
ALTER TABLE mes.approvals DROP CONSTRAINT IF EXISTS approvals_pkey;
ALTER TABLE mes.approvals ADD PRIMARY KEY (change_id, department, step);

-- The published organization's settings (the rest lives in the tables it is synced to): the
-- governance department, the standing approvers per kind of element, the approval steps' labels.
CREATE TABLE IF NOT EXISTS mes.organization (
  version    integer PRIMARY KEY,
  status     text NOT NULL CHECK (status IN ('published', 'superseded')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_one_published ON mes.organization (status) WHERE status = 'published';

-- ---- transactions (§25): a screen that changes several records as one, as a design element ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.

-- A transaction: its inputs and form, its checks and its steps. Published by a change like a service.
CREATE TABLE IF NOT EXISTS mes.transactions (
  name       text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('published', 'superseded')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_published ON mes.transactions (name) WHERE status = 'published';

-- The runs a transaction's screen lists and the audit's link from a record's rows to their run.
CREATE INDEX IF NOT EXISTS audit_log_transactions ON mes.audit_log (at) WHERE object = '$transaction';

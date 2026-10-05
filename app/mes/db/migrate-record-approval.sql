-- ---- approval of record changes (§28): a change to a record, made outside a transaction, that its
-- object's design says needs approval waits here until the stewards of what it changes have signed ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.

-- One request: what was asked (a new record, values of one, or an action on one), by whom and why,
-- on which version of the record, and who must sign (route: [{ department, because }]). It is applied
-- as its requester, with every check a direct change runs, when the last department signs; or void,
-- when the record changed meanwhile or the checks no longer pass.
CREATE TABLE IF NOT EXISTS mes.record_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object       text NOT NULL,
  record_id    uuid,
  op           text NOT NULL CHECK (op IN ('create', 'edit', 'action')),
  action       text,
  data         jsonb NOT NULL DEFAULT '{}',
  base_version bigint,
  def_version  integer NOT NULL,
  requested_by text NOT NULL REFERENCES mes.users (id),
  reason       text NOT NULL,
  route        jsonb NOT NULL,
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'rejected', 'void', 'withdrawn')),
  outcome      text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
-- One change waits per record at a time: a second would be decided against values the first may change.
CREATE UNIQUE INDEX IF NOT EXISTS record_requests_one_pending ON mes.record_requests (object, record_id) WHERE state = 'pending' AND record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS record_requests_waiting ON mes.record_requests (requested_at) WHERE state = 'pending';

-- Each department's signatures, one per step of its approval (§27.3), in order.
CREATE TABLE IF NOT EXISTS mes.record_request_approvals (
  request_id uuid NOT NULL REFERENCES mes.record_requests (id),
  department text NOT NULL,
  step       integer NOT NULL DEFAULT 1,
  user_id    text NOT NULL REFERENCES mes.users (id),
  decision   text NOT NULL CHECK (decision IN ('approve', 'reject')),
  meaning    text NOT NULL,
  note       text,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, department, step)
);

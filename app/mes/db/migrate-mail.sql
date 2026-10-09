-- ---- archiving that waits for approval, and mail to approving departments (§28.2, §28.6) ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.

-- A request may archive or restore a record (the MES deletes nothing: it archives), besides making,
-- changing and acting on one.
ALTER TABLE mes.record_requests DROP CONSTRAINT IF EXISTS record_requests_op_check;
ALTER TABLE mes.record_requests ADD CONSTRAINT record_requests_op_check CHECK (op IN ('create', 'edit', 'action', 'archive', 'restore'));

-- Mail to send: a department's mailbox told what waits for it. Kept until sent (SMTP_URL), or written to
-- the server's log where no mail server is set (development, tests); tried again on a failure, a little
-- later each time, and given up after eight tries, saying why. `key` makes one message of one event.
CREATE TABLE IF NOT EXISTS mes.mail_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  to_addr     text NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'logged', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS mail_outbox_due ON mes.mail_outbox (next_at) WHERE state = 'pending';

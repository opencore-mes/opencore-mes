-- ---- the audit chain, verified (§7.3; COMPLIANCE.md G3): how far it has been checked ----
-- Idempotent: safe to run again.

-- One row: the last entry the chain was verified up to (its seq and hash), when, and what was found. A check
-- carries on from here, so it reads only what was written since; a full check starts again from the first.
CREATE TABLE IF NOT EXISTS mes.audit_checkpoint (
    id          boolean PRIMARY KEY DEFAULT true CHECK (id),
    seq         bigint NOT NULL DEFAULT 0,
    hash        text NOT NULL DEFAULT repeat('0', 64),
    checked     bigint NOT NULL DEFAULT 0,
    verified_at timestamptz,
    ok          boolean,
    broken_at   bigint,
    problem     text
);
INSERT INTO mes.audit_checkpoint (id) VALUES (true) ON CONFLICT DO NOTHING;

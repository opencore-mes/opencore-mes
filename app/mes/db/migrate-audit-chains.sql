-- ---- the audit trail in several chains (§7.3) ----
-- One chain was one line every write of the plant waited in. The trail is now kept in 16 chains: each entry
-- on the chain of the record it is about (so a record's history is one chain), each chain linked, headed and
-- verified on its own; a transaction locks the heads of the chains it writes, and no others. The entries
-- already written are chain 0, as they were (their hashes unchanged); chains 1 to 15 start from nothing.
-- Idempotent: safe to run again. Every server of an installation is restarted onto it: one left on the code
-- before it can no longer write (its head's key is gone), and says so, rather than break the chains.
--
-- On a protected trail (ops/db/protect-audit.sql) the application may not alter it: this stops the start,
-- saying so. A database administrator runs this file as the trail's owner (mes_audit), then protect-audit.sql
-- again (its views take the new column).
DO $$
DECLARE
  at text := CASE WHEN to_regclass('audit.audit_log') IS NOT NULL THEN 'audit' ELSE 'mes' END;
BEGIN
  EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS chain smallint NOT NULL DEFAULT 0', at);
  EXECUTE format('CREATE INDEX IF NOT EXISTS audit_log_chain_seq ON %I.audit_log (chain, seq)', at);
  EXECUTE format('ALTER TABLE %I.audit_head ADD COLUMN IF NOT EXISTS chain smallint', at);
  EXECUTE format('UPDATE %I.audit_head SET chain = 0 WHERE chain IS NULL', at);
  -- From one row (id true) to one a chain.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
                 WHERE n.nspname = at AND t.relname = 'audit_head' AND c.contype = 'p' AND a.attname = 'chain') THEN
    EXECUTE format('ALTER TABLE %I.audit_head DROP CONSTRAINT IF EXISTS audit_head_pkey', at);
    EXECUTE format('ALTER TABLE %I.audit_head DROP CONSTRAINT IF EXISTS audit_head_id_check', at);
    EXECUTE format('ALTER TABLE %I.audit_head ALTER COLUMN chain SET NOT NULL', at);
    EXECUTE format('ALTER TABLE %I.audit_head ADD PRIMARY KEY (chain)', at);
  END IF;
  EXECUTE format('INSERT INTO %I.audit_head (chain, hash) SELECT c, repeat(''0'', 64) FROM generate_series(0, 15) c ON CONFLICT (chain) DO NOTHING', at);
  -- The one-head key is gone, so a server still on the code before chains (one head, "WHERE id") is refused
  -- each write it tries, until it is restarted, rather than moving every head at once and breaking every chain.
  -- (On a protected trail its view goes with it: protect-audit.sql, run again, makes it anew.)
  EXECUTE format('ALTER TABLE %I.audit_head DROP COLUMN IF EXISTS id CASCADE', at);
EXCEPTION WHEN insufficient_privilege OR wrong_object_type THEN
  RAISE EXCEPTION 'The audit trail is protected (ops/db/protect-audit.sql), so the application may not change it: a database administrator runs app/mes/db/migrate-audit-chains.sql as its owner, then ops/db/protect-audit.sql again; then start OpenCore MES. (%)', SQLERRM;
END $$;

-- Where each chain was last found sound: { "<chain>": { "seq": n, "hash": "…" } } (seq and hash stay chain 0's).
ALTER TABLE mes.audit_checkpoint ADD COLUMN IF NOT EXISTS chains jsonb NOT NULL DEFAULT '{}';

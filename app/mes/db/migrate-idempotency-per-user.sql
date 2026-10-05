-- A request key belongs to who sent it (idempotent): it was unique across everyone, so a key one
-- person had used made another's request fail, whoever guessed or chose it first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'mes' AND c.relname = 'idempotency' AND i.indisprimary AND i.indnatts = 1) THEN
    ALTER TABLE mes.idempotency DROP CONSTRAINT idempotency_pkey;
    ALTER TABLE mes.idempotency ADD PRIMARY KEY (user_id, key);
  END IF;
END $$;

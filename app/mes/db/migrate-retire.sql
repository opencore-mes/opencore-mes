-- ---- retiring a design (§5.10): out of use, never deleted ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it. A retired version stays, with its
-- history; publishing the same name again makes the next version.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['definitions', 'scripts', 'connections', 'services', 'transactions', 'screens'] LOOP
    EXECUTE format('ALTER TABLE mes.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_status_check');
    EXECUTE format('ALTER TABLE mes.%I ADD CONSTRAINT %I CHECK (status IN (''published'', ''superseded'', ''retired''))', t, t || '_status_check');
  END LOOP;
END $$;

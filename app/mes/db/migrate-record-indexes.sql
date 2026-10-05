-- ---- reading records at scale (§7.1, §10.1, §26) ----
-- Lists, screens and searches count, sort and search in the database (record-sql.js), each person's
-- rights compiled into the query: these indexes keep that fast with a million records of an object.
-- Made on the partitioned table, so every object's partition has them, a new one too. Idempotent: a
-- migration (migrate.mjs) and the reset both run it.

-- The list as it changed last, and a page of it.
CREATE INDEX IF NOT EXISTS records_updated ON mes.records (object, updated_at DESC, id);
-- A screen's records in some states (a table of what is on hold, a count of what is running): only
-- those in use, so a count reads the index alone.
CREATE INDEX IF NOT EXISTS records_state ON mes.records (object, state) WHERE archived_at IS NULL;
-- Fields equal to given values (a screen's `where`, a transaction's count, a scanned label), as
-- containment: data @> '{"machine": "<id>"}'.
CREATE INDEX IF NOT EXISTS records_data ON mes.records USING gin (data jsonb_path_ops);

-- Search (a list's filter, the navigator): any value containing the words typed, through trigrams
-- when pg_trgm may be installed here; without it the same search reads every record, slower.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXECUTE 'CREATE INDEX IF NOT EXISTS records_text ON mes.records USING gin ((data::text) gin_trgm_ops)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'records_text not made (%): search reads every record', SQLERRM;
END $$;

-- The order lists and tables sort in (client/sort.js): by words, digits as numbers ("OP-2" before
-- "OP-10"), case and accents aside. Without ICU, by code point.
DO $$
BEGIN
  CREATE COLLATION IF NOT EXISTS mes."natural" (provider = icu, locale = 'und-u-kn-ks-level1', deterministic = false);
EXCEPTION WHEN OTHERS THEN
  CREATE COLLATION IF NOT EXISTS mes."natural" FROM "C";
END $$;

-- Adds queries (§23) to a database made before them (idempotent). The views are built by the
-- server on first use.
-- else; the app's user becomes it for the length of one query.
CREATE SCHEMA IF NOT EXISTS q;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mes_query') THEN CREATE ROLE mes_query NOLOGIN; END IF;
END $$;
GRANT mes_query TO CURRENT_USER;
GRANT USAGE ON SCHEMA q TO mes_query;
-- Who is viewing, for the length of one query's transaction; a view reads the row of its own
-- transaction, and mes_query cannot read or write this table.
CREATE TABLE IF NOT EXISTS mes.query_context (
  txid     bigint PRIMARY KEY,
  user_id  text   NOT NULL,
  roles    jsonb  NOT NULL
);
-- Which definitions the views were last built from.
CREATE TABLE IF NOT EXISTS mes.query_views (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  signature  text NOT NULL,
  built_at   timestamptz NOT NULL
);

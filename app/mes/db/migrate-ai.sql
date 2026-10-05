-- Adds the AI design API's tables to a database made before them (idempotent).
CREATE TABLE IF NOT EXISTS mes.api_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES mes.users(id),
  name        text NOT NULL,
  agent       text NOT NULL DEFAULT '',
  scopes      text[] NOT NULL,
  hash        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used   timestamptz,
  revoked_at  timestamptz
);
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS ai_edits jsonb NOT NULL DEFAULT '[]';
CREATE UNLOGGED TABLE IF NOT EXISTS mes.presence (
  object text NOT NULL, id uuid NOT NULL, user_id text NOT NULL, name text NOT NULL,
  editing boolean NOT NULL DEFAULT false, since timestamptz NOT NULL DEFAULT now(), seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object, id, user_id)
);

-- ---- a second person signed in, and signing passwords (§7.4, Part 11 §11.200) ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.

-- A second person signed in beside the first at a station (at most two): the verifier of the
-- transactions that need one, until either signs out (the first signing out ends the session).
ALTER TABLE mes.sessions ADD COLUMN IF NOT EXISTS second_user_id text REFERENCES mes.users(id);
ALTER TABLE mes.sessions ADD COLUMN IF NOT EXISTS second_since timestamptz;

-- A password for signing only, for those who sign in through single sign-on (no password of their own
-- here, none in the plant's directory): scrypt, never the password. It never signs anyone in.
CREATE TABLE IF NOT EXISTS mes.signing_credentials (
    user_id  text PRIMARY KEY REFERENCES mes.users(id),
    hash     text NOT NULL,
    set_at   timestamptz NOT NULL DEFAULT now()
);

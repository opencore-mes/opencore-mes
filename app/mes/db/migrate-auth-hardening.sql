-- ---- sign-in hardened (§8.2, §7.4): what Part 11 §11.200, §11.300 and SOC 2 / ISO 27001 ask ----
-- Idempotent: safe to run again.

-- Sessions: kept by the SHA-256 of their id, whoever inserts one (sign-in, a sandbox, a test): the id is
-- in the browser's cookie only, so a copy of this table signs nobody in. An id already a SHA-256 (a row
-- copied from another sessions table) is kept as it is. And when the person last did something, for
-- the idle timeout.
CREATE OR REPLACE FUNCTION mes.sessions_hashed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id !~ '^[0-9a-f]{64}$' THEN NEW.id := encode(sha256(convert_to(NEW.id, 'UTF8')), 'hex'); END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sessions_hashed ON mes.sessions;
CREATE TRIGGER sessions_hashed BEFORE INSERT ON mes.sessions FOR EACH ROW EXECUTE FUNCTION mes.sessions_hashed();
UPDATE mes.sessions SET id = encode(sha256(convert_to(id, 'UTF8')), 'hex') WHERE id !~ '^[0-9a-f]{64}$';
ALTER TABLE mes.sessions ADD COLUMN IF NOT EXISTS last_seen timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS sessions_expiry ON mes.sessions (expires_at);

-- A fresh sign-in at the identity provider, for one signature (§7.4): who, in which session, when;
-- spent by the signature it is for. The single sign-on under way says what it is for.
CREATE TABLE IF NOT EXISTS mes.session_reauth (
    session_id text NOT NULL,
    user_id    text NOT NULL REFERENCES mes.users(id),
    at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id)
);
ALTER TABLE mes.oidc_states ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'sign-in';
ALTER TABLE mes.oidc_states ADD COLUMN IF NOT EXISTS reauth_session text;
ALTER TABLE mes.oidc_states ADD COLUMN IF NOT EXISTS reauth_user text;
ALTER TABLE mes.oidc_states ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now();

-- Passwords once used (their hashes), so a new one is not one of the last few (Part 11 §11.300).
CREATE TABLE IF NOT EXISTS mes.password_history (
    user_id  text NOT NULL REFERENCES mes.users(id),
    kind     text NOT NULL CHECK (kind IN ('password', 'signing')),
    hash     text NOT NULL,
    set_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_history_user ON mes.password_history (user_id, kind, set_at DESC);

-- A second factor for a password sign-in: an authenticator app's key (RFC 6238), the last time step
-- taken (a code is good once), and recovery codes (their SHA-256, each good once).
CREATE TABLE IF NOT EXISTS mes.mfa (
    user_id    text PRIMARY KEY REFERENCES mes.users(id),
    secret     text NOT NULL,
    enabled_at timestamptz,
    last_step  bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mes.mfa_recovery (
    user_id   text NOT NULL REFERENCES mes.users(id),
    code_hash text NOT NULL,
    used_at   timestamptz,
    PRIMARY KEY (user_id, code_hash)
);

-- A sign-in half done: the password held, the next step (a code, setting up the authenticator, a new
-- password for one that has expired) in a few minutes, by a token only its browser holds.
CREATE TABLE IF NOT EXISTS mes.sign_in_pending (
    token_hash text PRIMARY KEY,
    user_id    text NOT NULL REFERENCES mes.users(id),
    method     text NOT NULL,
    step       text NOT NULL CHECK (step IN ('code', 'enroll', 'expired')),
    return_to  text NOT NULL DEFAULT '/',
    expires_at timestamptz NOT NULL
);

-- AI and integration tokens expire. Those issued before keep working for 90 days more at least.
ALTER TABLE mes.api_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE mes.api_tokens SET expires_at = greatest(created_at + interval '365 days', now() + interval '90 days') WHERE expires_at IS NULL AND revoked_at IS NULL;

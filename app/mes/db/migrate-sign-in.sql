-- ---- sign-in (§8.2): passwords, links to set one, lockout, single sign-on ----
-- Idempotent: a migration (migrate.mjs) and the reset both run it.

-- A person's own password, for those not signing in through the plant's directory or provider: scrypt,
-- its parameters and salt in the hash, never the password.
CREATE TABLE IF NOT EXISTS mes.credentials (
    user_id  text PRIMARY KEY REFERENCES mes.users(id),
    hash     text NOT NULL,
    set_at   timestamptz NOT NULL DEFAULT now()
);

-- A one-time link to set a password (a new person, a forgotten one): only its SHA-256 kept.
CREATE TABLE IF NOT EXISTS mes.password_tokens (
    token_hash text PRIMARY KEY,
    user_id    text NOT NULL REFERENCES mes.users(id),
    made_by    text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);

-- Wrong passwords in a row, per sign-in id, and until when it is locked.
CREATE TABLE IF NOT EXISTS mes.sign_in_failures (
    user_id      text PRIMARY KEY,
    failures     integer NOT NULL DEFAULT 0,
    locked_until timestamptz,
    last_at      timestamptz NOT NULL DEFAULT now()
);

-- A single sign-on under way: its state (also in the browser's cookie), PKCE verifier and nonce, for
-- ten minutes.
CREATE TABLE IF NOT EXISTS mes.oidc_states (
    state      text PRIMARY KEY,
    verifier   text NOT NULL,
    nonce      text NOT NULL,
    return_to  text NOT NULL DEFAULT '/',
    expires_at timestamptz NOT NULL
);

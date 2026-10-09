-- Setup codes (DESIGN.md §8.2): five capital letters a person types with their sign-in id to set their first
-- password, for those with no mail or computer of their own (a printed slip). Kept beside the links, only
-- their hash (bound to the person), told apart by `kind`; a code is spent after a few wrong tries.
ALTER TABLE mes.password_tokens ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'link';
ALTER TABLE mes.password_tokens ADD COLUMN IF NOT EXISTS tries integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS password_tokens_user ON mes.password_tokens (user_id) WHERE used_at IS NULL;
-- Who has ever signed in: what the slips are printed for (those who never have), and a person's last sign-in.
CREATE INDEX IF NOT EXISTS audit_log_sign_in ON mes.audit_log (actor, at) WHERE object = '$auth' AND action = 'sign-in';

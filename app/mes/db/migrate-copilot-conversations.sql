-- ---- the copilot's conversations, kept with their change (§16.3) ----
-- One per person and change request: what the model was told and answered (messages) and what the
-- person reads (transcript), so a conversation resumes any time, after a reload or a restart. It goes
-- with its change. Idempotent: a migration (migrate.mjs) and the reset both run it.
CREATE TABLE IF NOT EXISTS mes.copilot_conversations (
    owner      text NOT NULL REFERENCES mes.users(id),
    change_id  uuid NOT NULL REFERENCES mes.change_requests(id) ON DELETE CASCADE,
    messages   jsonb NOT NULL DEFAULT '[]'::jsonb,
    transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
    saves      integer NOT NULL DEFAULT 0,
    running    boolean NOT NULL DEFAULT false,
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, change_id)
);

-- The analytics copilot's conversation (§34), one per person: what the model was told and answered
-- (messages), what the person reads (transcript), and the report it last drew, so it resumes after a
-- reload or a restart. Idempotent.
CREATE TABLE IF NOT EXISTS mes.analyst_conversations (
    owner      text PRIMARY KEY REFERENCES mes.users(id),
    messages   jsonb NOT NULL DEFAULT '[]'::jsonb,
    transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
    report     jsonb,
    running    boolean NOT NULL DEFAULT false,
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

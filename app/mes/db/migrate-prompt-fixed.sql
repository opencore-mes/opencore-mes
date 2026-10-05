-- ---- a kept prompt pinned to a report (§34.11): the same report each run, its queries kept ----
-- fixed: the report its runs repeat ({ description?, layout?, blocks }), as its owner kept it then; null:
-- the copilot is asked each time. fixed_from: the kept report it was taken from. words: "kept" (its words
-- as written, no AI) or "fresh" (the copilot writes only its words, from each run's answers). Idempotent.
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS fixed jsonb;
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS fixed_from uuid;
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS words text NOT NULL DEFAULT 'kept';
ALTER TABLE mes.report_prompts DROP CONSTRAINT IF EXISTS report_prompts_words_check;
ALTER TABLE mes.report_prompts ADD CONSTRAINT report_prompts_words_check CHECK (words IN ('kept', 'fresh'));

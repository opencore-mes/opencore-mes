-- A kept prompt's run by the clock, made sure of (DESIGN.md §34.7): the time it was due (a run made late
-- says so), how many times it has been tried (a run that fails for a while, the AI or the network away,
-- is tried again a few times), the instance running it (one that stopped finds its own run at its next
-- start, and makes it again), and what the last run says besides an error (made late, runs not made).
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS tries integer NOT NULL DEFAULT 0;
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS run_by text;
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS last_note text;

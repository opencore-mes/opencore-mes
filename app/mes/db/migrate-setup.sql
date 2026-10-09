-- Setup (DESIGN.md §5.15): a change executed on its designer's signature while the plant is being set up,
-- without review or approval. Who signed, when, and how they proved it; null for every other change.
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS setup jsonb;
CREATE INDEX IF NOT EXISTS change_requests_setup ON mes.change_requests (executed_at DESC) WHERE setup IS NOT NULL;

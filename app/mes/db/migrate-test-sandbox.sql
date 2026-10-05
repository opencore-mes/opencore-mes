-- ---- the test sandbox (§5.13): changes under test together, before anyone is asked to approve ----
-- test:   { at, by, order } while a change is under test: its place in the order the test sandbox
--         applies the changes in.
-- tested: what it was tested with, each time the test sandbox was built with it in:
--         [{ at, by, hash, ok, error?, with: [{ id, title, hash }] }] (the last 20). Kept with the change for
--         its reviewers and approvers, and after it executes.
-- Idempotent.
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS test jsonb;
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS tested jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS change_requests_under_test ON mes.change_requests ((test->>'order')) WHERE test IS NOT NULL;

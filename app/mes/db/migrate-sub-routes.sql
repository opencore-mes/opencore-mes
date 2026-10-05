-- ---- routes inside routes (§32.14): a route's sub flow runs another route, as a child run ----
-- One route under way per traveler still, at the top: its sub routes' runs are its children
-- (parent_id), under way with it. The index that held one route run per traveler made way for one
-- that holds one top route. Idempotent.
DROP INDEX IF EXISTS mes.flow_runs_one_route;
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_one_top_route ON mes.flow_runs (subject_id) WHERE kind = 'route' AND parent_id IS NULL AND state <> 'ended';

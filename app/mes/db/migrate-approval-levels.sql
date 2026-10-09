-- Approval levels (DESIGN.md §5.16): the level a change was submitted under ("one": one approver's signature
-- executes it); null for the full path, and for a change executed on its designer's signature (its `setup`).
ALTER TABLE mes.change_requests ADD COLUMN IF NOT EXISTS approval_level text;

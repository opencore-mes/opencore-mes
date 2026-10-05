-- A session keeps the page its desktop opens (§6.8), found at sign-in by the address it came from
-- (idempotent): the page then knows which one is this desktop's own, and opens it filled.
ALTER TABLE mes.sessions ADD COLUMN IF NOT EXISTS home text;
ALTER TABLE mes.sessions ADD COLUMN IF NOT EXISTS home_label text;

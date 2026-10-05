-- ---- pictures (§35): what an image field holds and a floor layout is drawn on ----
-- Kept by what they are (the SHA-256 of their bytes): the same picture uploaded twice is one row, and a
-- design or a record that names one names exactly those bytes, for ever. Never changed, never deleted
-- (a design approved last year still shows what its approvers saw). Idempotent.
CREATE TABLE IF NOT EXISTS mes.blobs (
  sha256     text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  type       text NOT NULL CHECK (type IN ('image/png', 'image/jpeg', 'image/webp')),
  size       integer NOT NULL CHECK (size > 0),
  bytes      bytea NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

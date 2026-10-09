-- Files on records and screens (DESIGN.md §35.4): a video (MP4, WebM) besides pictures and documents, the
-- name it was uploaded under (the first upload's: the bytes are kept once), and its bytes kept apart and
-- uncompressed (EXTERNAL), so a part of a long video is read without reading the whole (seeking).
ALTER TABLE mes.blobs DROP CONSTRAINT IF EXISTS blobs_type_check;
ALTER TABLE mes.blobs ADD CONSTRAINT blobs_type_check CHECK (type IN ('image/png', 'image/jpeg', 'image/webp',
  'application/pdf', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'video/mp4', 'video/webm'));
ALTER TABLE mes.blobs ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE mes.blobs ALTER COLUMN bytes SET STORAGE EXTERNAL;

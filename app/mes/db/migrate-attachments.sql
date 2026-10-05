-- ---- attachments (§34.10): documents beside pictures, and what a kept prompt is given ----
-- The store keeps PDFs, CSV files and Excel workbooks too (what the copilots read, what a report shows),
-- each kept by what it is, never changed, never deleted. Idempotent.
ALTER TABLE mes.blobs DROP CONSTRAINT IF EXISTS blobs_type_check;
ALTER TABLE mes.blobs ADD CONSTRAINT blobs_type_check CHECK (type IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
-- A kept prompt's attachments: [{ blob, name, type }], given to the copilot each time it is asked.
ALTER TABLE mes.report_prompts ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]';

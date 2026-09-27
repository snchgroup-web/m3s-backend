-- Candidate only: backup and explicit operator activation required.
-- No grants, no content rewrite, no deletion, no automatic startup migration.
BEGIN;
ALTER TABLE ged_private.documents DROP CONSTRAINT documents_byte_size_check;
ALTER TABLE ged_private.documents ADD CONSTRAINT documents_byte_size_check
  CHECK (byte_size BETWEEN 10 AND 5242880);
COMMIT;

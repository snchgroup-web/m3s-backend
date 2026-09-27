-- Operator-only migration, after verified backup. Never run at server startup.
BEGIN;
CREATE TABLE ged_private.revisions (
  tenant text NOT NULL,
  owner_id text NOT NULL,
  document_id text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  current_document_id text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 140 AND title = btrim(title) AND title !~ '[[:cntrl:]<>]'),
  trashed boolean NOT NULL,
  action text NOT NULL CHECK (action IN ('rename','version','trash','restore')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, document_id, revision),
  FOREIGN KEY (tenant, owner_id, document_id) REFERENCES ged_private.documents (tenant, owner_id, document_id),
  FOREIGN KEY (tenant, owner_id, current_document_id) REFERENCES ged_private.documents (tenant, owner_id, document_id)
);
ALTER TABLE ged_private.revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ged_private.revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY revisions_scope ON ged_private.revisions
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true))
  WITH CHECK (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
REVOKE ALL ON ged_private.revisions FROM PUBLIC;
GRANT SELECT, INSERT ON ged_private.revisions TO m3s_ged_app;
COMMIT;

-- LOCAL CANDIDATE: backup/restore verification and activation approval required.
-- No document, financial entry, payment or grant is created here.
BEGIN;
CREATE TABLE ged_private.income_document_links (
  tenant text NOT NULL,
  owner_id text NOT NULL,
  income_source text NOT NULL CHECK (length(income_source) BETWEEN 1 AND 256),
  income_id text NOT NULL CHECK (length(btrim(income_id)) BETWEEN 1 AND 128),
  document_id text NOT NULL,
  document_version_id text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  action text NOT NULL CHECK (action IN ('attach', 'detach')),
  document_role text NOT NULL CHECK (document_role IN ('invoice', 'payment_receipt', 'transfer_receipt', 'credit_note', 'other')),
  external_reference text CHECK (external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 140),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, income_source, income_id, document_id, revision),
  FOREIGN KEY (tenant, owner_id, document_id) REFERENCES ged_private.documents (tenant, owner_id, document_id),
  FOREIGN KEY (tenant, owner_id, document_version_id) REFERENCES ged_private.documents (tenant, owner_id, document_id)
);
ALTER TABLE ged_private.income_document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ged_private.income_document_links FORCE ROW LEVEL SECURITY;
CREATE POLICY income_document_links_scope ON ged_private.income_document_links
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true))
  WITH CHECK (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
REVOKE ALL ON ged_private.income_document_links FROM PUBLIC;
COMMIT;

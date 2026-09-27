-- LOCAL CANDIDATE ONLY: requires backup and explicit activation approval.
-- Expense existence and finance permissions must be checked against the
-- authoritative Finance source by the server before recording a link.
BEGIN;
CREATE TABLE ged_private.expense_document_links (
  tenant text NOT NULL,
  owner_id text NOT NULL,
  expense_source text NOT NULL CHECK (length(expense_source) BETWEEN 1 AND 256),
  expense_id text NOT NULL CHECK (length(btrim(expense_id)) BETWEEN 1 AND 128),
  document_id text NOT NULL,
  document_version_id text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  action text NOT NULL CHECK (action IN ('attach', 'detach')),
  document_role text NOT NULL CHECK (document_role IN ('invoice', 'payment_receipt', 'transfer_receipt', 'credit_note', 'other')),
  external_reference text CHECK (external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 140),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, expense_source, expense_id, document_id, revision),
  FOREIGN KEY (tenant, owner_id, document_id) REFERENCES ged_private.documents (tenant, owner_id, document_id),
  FOREIGN KEY (tenant, owner_id, document_version_id) REFERENCES ged_private.documents (tenant, owner_id, document_id)
);
ALTER TABLE ged_private.expense_document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ged_private.expense_document_links FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_document_links_scope ON ged_private.expense_document_links
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true))
  WITH CHECK (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
REVOKE ALL ON ged_private.expense_document_links FROM PUBLIC;
COMMIT;
-- No grants executed by this candidate. No amounts, budget allocations,
-- suppliers, projects, files or expense rows created by this table.

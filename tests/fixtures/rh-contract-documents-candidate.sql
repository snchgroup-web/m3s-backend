-- LOCAL CANDIDATE ONLY. Apply only to a disposable synthetic database.
-- Existing RH schema required. No role creation or runtime grants.
BEGIN;

CREATE TABLE rh_private.contract_documents (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  document_id text NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
  employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, document_id),
  UNIQUE (tenant, owner_id, document_id, employee_id),
  FOREIGN KEY (tenant, owner_id, employee_id)
    REFERENCES rh_private.employees (tenant, owner_id, employee_id)
);

CREATE TABLE rh_private.contract_document_links (
  tenant text NOT NULL,
  owner_id text NOT NULL,
  document_id text NOT NULL,
  version_id text NOT NULL CHECK (version_id ~ '^[a-f0-9]{64}$'),
  employee_id uuid NOT NULL,
  dossier_revision integer NOT NULL CHECK (dossier_revision BETWEEN 1 AND 9999),
  purpose text NOT NULL CHECK (purpose = 'contract_draft'),
  category text NOT NULL CHECK (category = 'rh'),
  classification text NOT NULL CHECK (classification = 'C3'),
  record_status text NOT NULL CHECK (record_status = 'draft'),
  trashed boolean NOT NULL CHECK (trashed = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, document_id, version_id),
  FOREIGN KEY (tenant, owner_id, document_id, employee_id)
    REFERENCES rh_private.contract_documents (tenant, owner_id, document_id, employee_id),
  FOREIGN KEY (tenant, owner_id, employee_id, dossier_revision)
    REFERENCES rh_private.employee_revisions (tenant, owner_id, employee_id, revision)
);

ALTER TABLE rh_private.contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.contract_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE rh_private.contract_document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.contract_document_links FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_documents_scope ON rh_private.contract_documents
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true))
  WITH CHECK (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
CREATE POLICY contract_document_links_scope ON rh_private.contract_document_links
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true))
  WITH CHECK (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
REVOKE ALL ON rh_private.contract_documents, rh_private.contract_document_links FROM PUBLIC;
COMMENT ON TABLE rh_private.contract_document_links IS
  'Local candidate: immutable draft contract references only; no files, signatures or employee accounts';
COMMIT;

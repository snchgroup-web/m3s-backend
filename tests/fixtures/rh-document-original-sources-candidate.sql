-- LOCAL CANDIDATE: operator declarations only, no startup migration or grants.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE rh_private.document_original_decision_revisions (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  employee_id uuid NOT NULL,
  dossier_revision integer NOT NULL CHECK (dossier_revision BETWEEN 1 AND 9999),
  document_id text NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
  version_id text NOT NULL CHECK (version_id ~ '^[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK (purpose = 'contract_draft'),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  can_verify_original boolean NOT NULL,
  decision_ref text NOT NULL CHECK (decision_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, employee_id, dossier_revision, document_id, version_id, purpose, revision),
  FOREIGN KEY (tenant, owner_id, employee_id, dossier_revision)
    REFERENCES rh_private.employee_revisions (tenant, owner_id, employee_id, revision)
);

CREATE TABLE rh_private.contract_document_original_revisions (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  document_id text NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
  version_id text NOT NULL CHECK (version_id ~ '^[a-f0-9]{64}$'),
  catalog_revision integer NOT NULL CHECK (catalog_revision BETWEEN 1 AND 10000),
  metadata_revision integer NOT NULL CHECK (metadata_revision BETWEEN 1 AND 10000),
  employee_id uuid NOT NULL,
  dossier_revision integer NOT NULL CHECK (dossier_revision BETWEEN 1 AND 9999),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 10 AND 1048576),
  object_generation text NOT NULL CHECK (object_generation ~ '^[1-9][0-9]{0,29}$'),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  withdrawn boolean NOT NULL,
  source_ref text NOT NULL CHECK (source_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, document_id, version_id, catalog_revision),
  FOREIGN KEY (tenant, owner_id, employee_id, dossier_revision)
    REFERENCES rh_private.employee_revisions (tenant, owner_id, employee_id, revision),
  FOREIGN KEY (tenant, owner_id, document_id, version_id, metadata_revision)
    REFERENCES rh_private.contract_document_metadata_revisions
      (tenant, owner_id, document_id, version_id, metadata_revision)
);

ALTER TABLE rh_private.document_original_decision_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.document_original_decision_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_original_decisions_read ON rh_private.document_original_decision_revisions FOR SELECT
  USING (tenant = (SELECT current_setting('m3s.tenant', true))
    AND owner_id = (SELECT current_setting('m3s.owner', true)));
ALTER TABLE rh_private.contract_document_original_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.contract_document_original_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_document_originals_read ON rh_private.contract_document_original_revisions FOR SELECT
  USING (tenant = (SELECT current_setting('m3s.tenant', true))
    AND owner_id = (SELECT current_setting('m3s.owner', true)));
REVOKE ALL ON rh_private.document_original_decision_revisions,
  rh_private.contract_document_original_revisions FROM PUBLIC;
COMMIT;

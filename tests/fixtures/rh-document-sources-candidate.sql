-- LOCAL CANDIDATE ONLY: disposable synthetic databases, never startup.
-- Source declarations are operator-maintained, not derived from attachment requests.
BEGIN;

CREATE TABLE rh_private.mutation_entitlement_revisions (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  can_revise boolean NOT NULL,
  decision_ref text NOT NULL CHECK (decision_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, revision)
);

CREATE TABLE rh_private.document_attachment_decision_revisions (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  employee_id uuid NOT NULL,
  dossier_revision integer NOT NULL CHECK (dossier_revision BETWEEN 1 AND 9999),
  document_id text NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
  version_id text NOT NULL CHECK (version_id ~ '^[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK (purpose = 'contract_draft'),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  can_attach boolean NOT NULL,
  decision_ref text NOT NULL CHECK (decision_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, employee_id, dossier_revision, document_id, version_id, purpose, revision),
  FOREIGN KEY (tenant, owner_id, employee_id, dossier_revision)
    REFERENCES rh_private.employee_revisions (tenant, owner_id, employee_id, revision)
);

CREATE TABLE rh_private.contract_document_metadata_revisions (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  document_id text NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
  version_id text NOT NULL CHECK (version_id ~ '^[a-f0-9]{64}$'),
  metadata_revision integer NOT NULL CHECK (metadata_revision BETWEEN 1 AND 10000),
  employee_id uuid NOT NULL,
  dossier_revision integer NOT NULL CHECK (dossier_revision BETWEEN 1 AND 9999),
  purpose text NOT NULL CHECK (purpose = 'contract_draft'),
  category text NOT NULL CHECK (category = 'rh'),
  classification text NOT NULL CHECK (classification = 'C3'),
  record_status text NOT NULL CHECK (record_status = 'draft'),
  trashed boolean NOT NULL,
  source_ref text NOT NULL CHECK (source_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, document_id, version_id, metadata_revision),
  FOREIGN KEY (tenant, owner_id, employee_id, dossier_revision)
    REFERENCES rh_private.employee_revisions (tenant, owner_id, employee_id, revision)
);

ALTER TABLE rh_private.mutation_entitlement_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.mutation_entitlement_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY mutation_entitlements_read ON rh_private.mutation_entitlement_revisions FOR SELECT
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
ALTER TABLE rh_private.document_attachment_decision_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.document_attachment_decision_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_attachment_decisions_read ON rh_private.document_attachment_decision_revisions FOR SELECT
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
ALTER TABLE rh_private.contract_document_metadata_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.contract_document_metadata_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_document_metadata_read ON rh_private.contract_document_metadata_revisions FOR SELECT
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
REVOKE ALL ON rh_private.mutation_entitlement_revisions,
  rh_private.document_attachment_decision_revisions,
  rh_private.contract_document_metadata_revisions FROM PUBLIC;
COMMIT;

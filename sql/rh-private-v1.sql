-- Operator-only initialization, after a verified backup. Never run at startup.
-- No employee, account, entitlement, role or application grant is created here.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE SCHEMA rh_private;
REVOKE ALL ON SCHEMA rh_private FROM PUBLIC;

CREATE TABLE rh_private.schema_versions (
  version text PRIMARY KEY CHECK (version = 'rh-read-v1'),
  installed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO rh_private.schema_versions(version) VALUES ('rh-read-v1');

CREATE TABLE rh_private.employees (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  employee_id uuid NOT NULL,
  identity_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, employee_id),
  UNIQUE (tenant, owner_id, identity_ref)
);

CREATE TABLE rh_private.creation_requests (
  tenant text NOT NULL,
  owner_id text NOT NULL,
  request_id uuid NOT NULL,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, request_id),
  FOREIGN KEY (tenant, owner_id, employee_id)
    REFERENCES rh_private.employees (tenant, owner_id, employee_id)
);

CREATE TABLE rh_private.employee_revisions (
  tenant text NOT NULL,
  owner_id text NOT NULL,
  employee_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  position_ref text CHECK (position_ref IS NULL OR position_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  site_ref text CHECK (site_ref IS NULL OR site_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  employment_start_date date,
  record_status text NOT NULL CHECK (record_status = 'draft'),
  classification text NOT NULL CHECK (classification = 'C3'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, employee_id, revision),
  FOREIGN KEY (tenant, owner_id, employee_id)
    REFERENCES rh_private.employees (tenant, owner_id, employee_id)
);

-- Maintenance appends a decision or revocation. The reader cannot grant itself access.
CREATE TABLE rh_private.entitlement_revisions (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  can_read boolean NOT NULL,
  decision_ref text NOT NULL CHECK (decision_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, revision)
);

ALTER TABLE rh_private.schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.schema_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY schema_version_read ON rh_private.schema_versions FOR SELECT USING (true);

ALTER TABLE rh_private.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.employees FORCE ROW LEVEL SECURITY;
CREATE POLICY employees_scope ON rh_private.employees
  USING (tenant = (SELECT current_setting('m3s.tenant', true)) AND owner_id = (SELECT current_setting('m3s.owner', true)))
  WITH CHECK (tenant = (SELECT current_setting('m3s.tenant', true)) AND owner_id = (SELECT current_setting('m3s.owner', true)));
ALTER TABLE rh_private.employee_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.employee_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_revisions_scope ON rh_private.employee_revisions
  USING (tenant = (SELECT current_setting('m3s.tenant', true)) AND owner_id = (SELECT current_setting('m3s.owner', true)))
  WITH CHECK (tenant = (SELECT current_setting('m3s.tenant', true)) AND owner_id = (SELECT current_setting('m3s.owner', true)));
ALTER TABLE rh_private.creation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.creation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY creation_requests_scope ON rh_private.creation_requests
  USING (tenant = (SELECT current_setting('m3s.tenant', true)) AND owner_id = (SELECT current_setting('m3s.owner', true)))
  WITH CHECK (tenant = (SELECT current_setting('m3s.tenant', true)) AND owner_id = (SELECT current_setting('m3s.owner', true)));
ALTER TABLE rh_private.entitlement_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rh_private.entitlement_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlement_revisions_read ON rh_private.entitlement_revisions FOR SELECT
  USING (tenant = (SELECT current_setting('m3s.tenant', true)) AND owner_id = (SELECT current_setting('m3s.owner', true)));

REVOKE ALL ON ALL TABLES IN SCHEMA rh_private FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE n.nspname='rh_private' AND acl.grantee<>c.relowner
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n,
      LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) acl
    WHERE n.nspname='rh_private' AND acl.grantee<>n.nspowner
  ) THEN
    RAISE EXCEPTION 'Unexpected inherited grants; initialization refused';
  END IF;
END $$;
COMMENT ON SCHEMA rh_private IS 'Restricted RH draft register; no employee accounts, payroll or automatic entitlements';
COMMIT;

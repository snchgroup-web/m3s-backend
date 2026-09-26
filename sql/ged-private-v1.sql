-- Explicit one-time migration; never run during application startup.
-- Run in the dedicated Railway GED database, as its schema owner.
BEGIN;
CREATE SCHEMA ged_private;
REVOKE ALL ON SCHEMA ged_private FROM PUBLIC;

CREATE TABLE ged_private.documents (
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  document_id text NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
  filename text NOT NULL CHECK (length(filename) BETWEEN 5 AND 144),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 10 AND 1048576),
  generation text NOT NULL CHECK (generation ~ '^[1-9][0-9]{0,29}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_id, document_id)
);
CREATE TABLE ged_private.events (
  event_id uuid PRIMARY KEY,
  tenant text NOT NULL CHECK (tenant ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  document_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('import', 'download')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant, owner_id, document_id)
    REFERENCES ged_private.documents (tenant, owner_id, document_id)
);
ALTER TABLE ged_private.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ged_private.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE ged_private.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ged_private.events FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_scope ON ged_private.documents
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true))
  WITH CHECK (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
CREATE POLICY events_scope ON ged_private.events
  USING (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true))
  WITH CHECK (tenant = current_setting('m3s.tenant', true) AND owner_id = current_setting('m3s.owner', true));
REVOKE ALL ON ALL TABLES IN SCHEMA ged_private FROM PUBLIC;
COMMENT ON SCHEMA ged_private IS 'M3S private GED v1; owner-scoped immutable document register';
COMMIT;

-- Provision m3s_ged_app separately with LOGIN, NOSUPERUSER, NOCREATEDB,
-- NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, NOINHERIT and no role memberships.
-- GRANT USAGE ON SCHEMA ged_private TO m3s_ged_app;
-- GRANT SELECT, INSERT ON ged_private.documents TO m3s_ged_app;
-- GRANT INSERT ON ged_private.events TO m3s_ged_app;
-- No UPDATE, DELETE, TRUNCATE, DDL or ownership for this runtime role.

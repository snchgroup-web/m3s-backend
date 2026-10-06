-- Maintenance only, after backup and a separate human approval.
-- Credential entry and LOGIN activation are deliberately separate.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='m3s_rh_reader') OR
     (SELECT count(*) FROM rh_private.schema_versions WHERE version='rh-read-v1') <> 1 OR
     (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='rh_private' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) <> 5
  THEN RAISE EXCEPTION 'RH reader prerequisites not qualified'; END IF;
END $$;
CREATE ROLE m3s_rh_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO m3s_rh_reader', current_database());
END $$;
GRANT USAGE ON SCHEMA rh_private TO m3s_rh_reader;
GRANT SELECT ON rh_private.schema_versions, rh_private.employees,
  rh_private.employee_revisions, rh_private.entitlement_revisions TO m3s_rh_reader;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
      WHERE r.rolname='m3s_rh_reader') OR
     EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='rh_private' AND c.relkind='r' AND
         (has_table_privilege('m3s_rh_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_table_privilege('m3s_rh_reader',c.oid,'SELECT') <> (c.relname <> 'creation_requests'))) OR
     has_schema_privilege('m3s_rh_reader','rh_private','CREATE') OR
     EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema','rh_private')
         AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','v','m','p','f')
         AND has_table_privilege('m3s_rh_reader',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  THEN RAISE EXCEPTION 'Unexpected RH reader privileges'; END IF;
END $$;
COMMIT;

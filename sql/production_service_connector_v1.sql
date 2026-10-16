-- Operator-only. Run after native isolated checks and action-time approval.
-- Credential entry and LOGIN activation are a separate user handoff.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $guard$
BEGIN
  IF (SELECT count(*) FROM production_private.schema_versions WHERE version=1)<>1 OR
     NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='m3s_production_service_app' AND NOT rolcanlogin AND NOT rolinherit
       AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) OR
     EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='m3s_production_service_app')) THEN
    RAISE EXCEPTION 'SERVICE_FOUNDATION_DRIFT';
  END IF;
END $guard$;
CREATE ROLE m3s_production_service_connector NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
DO $database$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO m3s_production_service_connector',current_database());
END $database$;
GRANT m3s_production_service_app TO m3s_production_service_connector WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
DO $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    AND c.relkind IN('r','p','v','m','f') AND (has_table_privilege('m3s_production_service_connector',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('m3s_production_service_connector',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) OR
    EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN('pg_catalog','information_schema')
      AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' AND has_schema_privilege('m3s_production_service_connector',oid,'CREATE')) THEN
    RAISE EXCEPTION 'SERVICE_CONNECTOR_UNEXPECTED_ACCESS';
  END IF;
END $guard$;
COMMIT;

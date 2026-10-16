-- Operator-only, after verified backup/restore. No bootstrap, grant seed or login secret.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
CREATE SCHEMA production_private;
REVOKE ALL ON SCHEMA production_private FROM PUBLIC;
CREATE ROLE m3s_production_service_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA production_private TO m3s_production_service_app;
CREATE TABLE production_private.schema_versions (
  version integer PRIMARY KEY CHECK(version=1), installed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_private.schema_versions(version) VALUES(1);
CREATE TABLE production_private.access_decisions (
  tenant text NOT NULL CHECK(tenant ~ '^[a-f0-9]{64}$'),
  actor text NOT NULL CHECK(actor ~ '^[a-f0-9]{64}$'),
  track text NOT NULL CHECK(track IN ('documents','rh')),
  can_read boolean NOT NULL DEFAULT false, can_prepare boolean NOT NULL DEFAULT false,
  can_deliver boolean NOT NULL DEFAULT false, can_accept boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT false, decision_reference text NOT NULL CHECK(length(decision_reference) BETWEEN 1 AND 300),
  PRIMARY KEY(tenant,actor,track),
  CHECK(can_read OR NOT (can_prepare OR can_deliver OR can_accept))
);
CREATE TABLE production_private.cycles (
  tenant text NOT NULL CHECK(tenant ~ '^[a-f0-9]{64}$'), id uuid NOT NULL,
  track text NOT NULL CHECK(track IN ('documents','rh')), setup jsonb NOT NULL CHECK(jsonb_typeof(setup)='object' AND setup->>'track'=track),
  created_by text NOT NULL CHECK(created_by ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 60),
  PRIMARY KEY(tenant,id), UNIQUE(tenant,created_by,request_id)
);
CREATE INDEX cycles_track_created ON production_private.cycles(tenant,track,created_at DESC,id);
CREATE TABLE production_private.events (
  tenant text NOT NULL, cycle_id uuid NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 60),
  step text NOT NULL CHECK(step IN ('realization','delivery','acceptance')),
  event jsonb NOT NULL CHECK(jsonb_typeof(event)='object' AND event->>'step'=step),
  actor text NOT NULL CHECK(actor ~ '^[a-f0-9]{64}$'), recorded_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(tenant,cycle_id,revision), UNIQUE(tenant,actor,request_id),
  FOREIGN KEY(tenant,cycle_id) REFERENCES production_private.cycles(tenant,id)
);
ALTER TABLE production_private.schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_private.schema_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE production_private.access_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_private.access_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE production_private.cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_private.cycles FORCE ROW LEVEL SECURITY;
ALTER TABLE production_private.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_private.events FORCE ROW LEVEL SECURITY;
CREATE POLICY version_read ON production_private.schema_versions FOR SELECT TO m3s_production_service_app USING(true);
CREATE POLICY own_decision ON production_private.access_decisions FOR SELECT TO m3s_production_service_app USING(
  tenant=current_setting('m3s.production_tenant',true) AND actor=current_setting('m3s.production_actor',true));
CREATE POLICY cycle_read ON production_private.cycles FOR SELECT TO m3s_production_service_app USING(
  tenant=current_setting('m3s.production_tenant',true) AND EXISTS(SELECT 1 FROM production_private.access_decisions a
    WHERE a.tenant=cycles.tenant AND a.track=cycles.track AND a.active AND a.can_read));
CREATE POLICY cycle_create ON production_private.cycles FOR INSERT TO m3s_production_service_app WITH CHECK(
  tenant=current_setting('m3s.production_tenant',true) AND created_by=current_setting('m3s.production_actor',true)
  AND revision=0 AND EXISTS(SELECT 1 FROM production_private.access_decisions a
    WHERE a.tenant=cycles.tenant AND a.track=cycles.track AND a.active AND a.can_prepare));
CREATE POLICY cycle_advance ON production_private.cycles FOR UPDATE TO m3s_production_service_app USING(
  tenant=current_setting('m3s.production_tenant',true) AND EXISTS(SELECT 1 FROM production_private.access_decisions a
    WHERE a.tenant=cycles.tenant AND a.track=cycles.track AND a.active AND a.can_read AND (a.can_prepare OR a.can_deliver OR a.can_accept)))
  WITH CHECK(tenant=current_setting('m3s.production_tenant',true));
CREATE POLICY event_read ON production_private.events FOR SELECT TO m3s_production_service_app USING(
  tenant=current_setting('m3s.production_tenant',true) AND EXISTS(SELECT 1 FROM production_private.cycles c WHERE c.tenant=events.tenant AND c.id=events.cycle_id));
CREATE POLICY event_create ON production_private.events FOR INSERT TO m3s_production_service_app WITH CHECK(
  tenant=current_setting('m3s.production_tenant',true) AND actor=current_setting('m3s.production_actor',true)
  AND EXISTS(SELECT 1 FROM production_private.cycles c JOIN production_private.access_decisions a ON a.tenant=c.tenant AND a.track=c.track
    WHERE c.tenant=events.tenant AND c.id=events.cycle_id AND a.active AND a.can_read AND
      CASE events.step WHEN 'realization' THEN a.can_prepare WHEN 'delivery' THEN a.can_deliver WHEN 'acceptance' THEN a.can_accept ELSE false END));
REVOKE ALL ON ALL TABLES IN SCHEMA production_private FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA production_private TO m3s_production_service_app;
GRANT INSERT ON production_private.cycles, production_private.events TO m3s_production_service_app;
GRANT UPDATE(revision) ON production_private.cycles TO m3s_production_service_app;
DO $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE n.nspname='production_private' AND c.relkind='r'
      AND a.grantee NOT IN(c.relowner,(SELECT oid FROM pg_roles WHERE rolname='m3s_production_service_app'))) THEN
    RAISE EXCEPTION 'SERVICE_UNEXPECTED_DEFAULT_GRANT';
  END IF;
END
$guard$;
COMMIT;

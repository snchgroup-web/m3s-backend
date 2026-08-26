BEGIN;

CREATE SCHEMA IF NOT EXISTS ref01;
REVOKE ALL ON SCHEMA ref01 FROM PUBLIC;

CREATE TABLE ref01.event (
  id uuid PRIMARY KEY,
  object_id uuid NOT NULL,
  object_type text NOT NULL CHECK (
    object_type IN ('person', 'membership', 'team', 'collective_responsibility')
  ),
  event_type text NOT NULL CHECK (
    event_type IN ('register', 'activate', 'update', 'transfer', 'suspend', 'close')
  ),
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by_subject_id uuid NOT NULL,
  validated_by_subject_id uuid NOT NULL,
  evidence_ref text,
  confidentiality text NOT NULL DEFAULT 'C2' CHECK (
    confidentiality IN ('C1', 'C2', 'C3', 'C4')
  ),
  previous_version_id uuid,
  idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
  expected_object_version integer NOT NULL CHECK (expected_object_version >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (requested_by_subject_id <> validated_by_subject_id)
);

CREATE TABLE ref01.object_version (
  id uuid PRIMARY KEY,
  object_id uuid NOT NULL,
  object_type text NOT NULL CHECK (
    object_type IN ('person', 'membership', 'team', 'collective_responsibility')
  ),
  version_number integer NOT NULL CHECK (version_number > 0),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  snapshot jsonb NOT NULL,
  source_event_id uuid NOT NULL UNIQUE REFERENCES ref01.event(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_id, object_type, version_number),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

ALTER TABLE ref01.event
  ADD CONSTRAINT ref01_event_previous_version_fk
  FOREIGN KEY (previous_version_id) REFERENCES ref01.object_version(id);

CREATE UNIQUE INDEX ref01_object_version_one_current_idx
  ON ref01.object_version (object_id, object_type)
  WHERE valid_to IS NULL;

CREATE TABLE ref01.membership_period (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL,
  team_id uuid NOT NULL,
  role_code text NOT NULL CHECK (length(btrim(role_code)) > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  source_event_id uuid NOT NULL UNIQUE REFERENCES ref01.event(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE ref01.evidence_link (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES ref01.event(id),
  evidence_ref text NOT NULL CHECK (length(btrim(evidence_ref)) > 0),
  classification text NOT NULL DEFAULT 'C2' CHECK (
    classification IN ('C2', 'C3', 'C4')
  ),
  retained_by text NOT NULL DEFAULT 'GED' CHECK (retained_by = 'GED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, evidence_ref)
);

CREATE TABLE ref01.outbox (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES ref01.event(id),
  topic text NOT NULL CHECK (length(btrim(topic)) > 0),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE INDEX ref01_event_object_timeline_idx
  ON ref01.event (object_id, object_type, effective_at DESC, recorded_at DESC);
CREATE INDEX ref01_membership_person_idx
  ON ref01.membership_period (person_id, starts_at DESC);
CREATE INDEX ref01_membership_team_idx
  ON ref01.membership_period (team_id, starts_at DESC);
CREATE INDEX ref01_outbox_dispatch_idx
  ON ref01.outbox (status, available_at)
  WHERE status IN ('pending', 'failed');

CREATE FUNCTION ref01.reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ref01.event is append-only';
END;
$$;

CREATE TRIGGER ref01_event_append_only
BEFORE UPDATE OR DELETE ON ref01.event
FOR EACH ROW EXECUTE FUNCTION ref01.reject_event_mutation();

CREATE FUNCTION ref01.reject_membership_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ref01.membership_period existing
    WHERE existing.person_id = NEW.person_id
      AND existing.team_id = NEW.team_id
      AND existing.id <> NEW.id
      AND tstzrange(existing.starts_at, existing.ends_at, '[)')
          && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping membership period for person % and team %',
      NEW.person_id, NEW.team_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ref01_membership_no_overlap
BEFORE INSERT OR UPDATE ON ref01.membership_period
FOR EACH ROW EXECUTE FUNCTION ref01.reject_membership_overlap();

REVOKE ALL ON ALL TABLES IN SCHEMA ref01 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ref01 FROM PUBLIC;

COMMIT;

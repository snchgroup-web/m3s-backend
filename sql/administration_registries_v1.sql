-- M3S Administration registries V1
-- Run explicitly after review. This migration does not import local browser data.

CREATE TABLE IF NOT EXISTS `mon-projet-data-2sg.m3s_2sg.administration_resources` (
  id STRING NOT NULL,
  tenant_id STRING NOT NULL,
  title STRING NOT NULL,
  family STRING NOT NULL,
  authority STRING NOT NULL,
  location STRING NOT NULL,
  source_status STRING NOT NULL,
  review_status STRING NOT NULL,
  confidentiality STRING NOT NULL,
  note STRING,
  created_by_user_id STRING NOT NULL,
  created_by_name STRING,
  created_at TIMESTAMP NOT NULL,
  updated_by_user_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  deleted_at TIMESTAMP
)
PARTITION BY DATE(created_at)
CLUSTER BY tenant_id, confidentiality, family;

CREATE TABLE IF NOT EXISTS `mon-projet-data-2sg.m3s_2sg.administration_correspondence` (
  id STRING NOT NULL,
  tenant_id STRING NOT NULL,
  receipt_date DATE NOT NULL,
  direction STRING NOT NULL,
  channel STRING NOT NULL,
  sender STRING NOT NULL,
  recipient STRING NOT NULL,
  subject STRING NOT NULL,
  category STRING NOT NULL,
  confidentiality STRING NOT NULL,
  linked_person_or_case STRING,
  ged_reference STRING,
  receipt_evidence_reference STRING,
  owner STRING NOT NULL,
  next_action STRING,
  status STRING NOT NULL,
  deadline DATE,
  created_by_user_id STRING NOT NULL,
  created_by_name STRING,
  created_at TIMESTAMP NOT NULL,
  updated_by_user_id STRING NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  deleted_at TIMESTAMP
)
PARTITION BY receipt_date
CLUSTER BY tenant_id, confidentiality, status;

CREATE TABLE IF NOT EXISTS `mon-projet-data-2sg.m3s_2sg.administration_audit_log` (
  id STRING NOT NULL,
  tenant_id STRING NOT NULL,
  actor_user_id STRING NOT NULL,
  actor_name STRING,
  entity_type STRING NOT NULL,
  entity_id STRING NOT NULL,
  action STRING NOT NULL,
  event_at TIMESTAMP NOT NULL,
  metadata_json STRING
)
PARTITION BY DATE(event_at)
CLUSTER BY tenant_id, entity_type, action;

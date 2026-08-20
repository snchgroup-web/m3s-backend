-- M3S Management portfolio V1
-- The runtime migration creates these tables and imports only missing seed rows.
-- Personal agent assignments remain NULL until an authorized human decision.

CREATE TABLE IF NOT EXISTS `mon-projet-data-2sg.m3s_2sg.management_portfolios` (
  portfolio_id STRING NOT NULL,
  tenant_id STRING NOT NULL,
  function_id STRING NOT NULL,
  title STRING NOT NULL,
  status STRING NOT NULL,
  confidentiality STRING NOT NULL,
  responsible_agent_id STRING,
  source_ref STRING NOT NULL,
  verified_on DATE NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
)
CLUSTER BY tenant_id, status;

CREATE TABLE IF NOT EXISTS `mon-projet-data-2sg.m3s_2sg.management_dossiers` (
  dossier_id STRING NOT NULL,
  tenant_id STRING NOT NULL,
  portfolio_id STRING NOT NULL,
  dossier_type STRING NOT NULL,
  display_title STRING NOT NULL,
  status STRING NOT NULL,
  confidentiality STRING NOT NULL,
  responsible_agent_id STRING,
  responsible_status STRING NOT NULL,
  display_state STRING NOT NULL,
  verified_on DATE NOT NULL,
  display_next_action STRING NOT NULL,
  source_ref STRING NOT NULL,
  evidence_ged_ref STRING,
  record_status STRING NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
)
PARTITION BY verified_on
CLUSTER BY tenant_id, portfolio_id, confidentiality, status;

CREATE TABLE IF NOT EXISTS `mon-projet-data-2sg.m3s_2sg.management_assignments` (
  assignment_id STRING NOT NULL,
  tenant_id STRING NOT NULL,
  object_type STRING NOT NULL,
  object_id STRING NOT NULL,
  function_candidate STRING NOT NULL,
  responsibility STRING NOT NULL,
  agent_id STRING,
  assignment_status STRING NOT NULL,
  justification STRING NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
)
CLUSTER BY tenant_id, object_type, object_id, responsibility;

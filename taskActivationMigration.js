const { buildTaskActivationSchemaProposal, TASK_TABLE_CONTRACTS } = require('./taskRegistry');
const { STANDARDISATION_TABLE_CONTRACTS, buildStandardisationRegistrationPreparation, DECISION_SHA256 } = require('./taskStandardisationReferences');
const { TASK_EXECUTION_CONTRACT_VERSION } = require('./taskExecutionContract');
const { hasExpectedBigQueryTableContract } = require('./bigQueryTableContract');

const TARGET = Object.freeze({ projectId: 'mon-projet-data-2sg', datasetId: 'm3s_2sg', location: 'US' });
const CONTRACTS = { ...STANDARDISATION_TABLE_CONTRACTS, ...TASK_TABLE_CONTRACTS };
const PROJECT_ID = 'PRJ-STD-M3S-20261018';
const REGISTRATION = 'REG-STD-M3S-20261018-001';
const table = name => `\`${TARGET.projectId}.${TARGET.datasetId}.${name}\``;
const literal = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function assertNativeTable(name, metadata) {
  if (!CONTRACTS[name] || metadata?.type !== 'TABLE' || metadata.location !== TARGET.location
      || metadata.tableReference?.projectId !== TARGET.projectId || metadata.tableReference?.datasetId !== TARGET.datasetId
      || metadata.tableReference?.tableId !== name || metadata.expirationTime || metadata.timePartitioning?.expirationMs
      || !hasExpectedBigQueryTableContract(metadata, CONTRACTS[name])) throw Error('TASK_MIGRATION_TABLE_MISMATCH');
}

function registrationRows(actorId) {
  if (typeof actorId !== 'string' || !actorId.trim() || actorId !== actorId.trim() || actorId.length > 200
      || /[\x00-\x1f\x7f-\x9f]/.test(actorId)) throw Error('TASK_MIGRATION_AUTHENTICATED_ACTOR_REQUIRED');
  const p = buildStandardisationRegistrationPreparation();
  const approve = (r, id) => ({ ...r, id, governance_status: 'approved', status: 'active', registration_reference: REGISTRATION });
  return {
    management_projects: [approve(p.project, PROJECT_ID)],
    management_project_phases: p.phases.map((r, i) => ({ ...approve(r, `PHASE-STD-M3S-20261018-${i + 1}`), project_id: PROJECT_ID })),
    management_task_assignments: [{ ...approve(p.assignment, 'AFF-STD-M3S-20261018-PILOT'), project_id: PROJECT_ID, actor_user_id: actorId }]
  };
}

// Operator-only plan. No cloud client, environment access or invocation on import.
function buildApprovedTaskMigration(actorId) {
  const rows = registrationRows(actorId);
  const insert = (name, row) => {
    const fields = CONTRACTS[name].fields.map(f => f.name);
    return `INSERT INTO ${table(name)} (${fields.join(',')}) VALUES (${fields.map(f => f === 'actor_user_id' ? '@actor' : typeof row[f] === 'number' ? row[f] : literal(row[f])).join(',')});`;
  };
  const sql = `BEGIN TRANSACTION;
    ASSERT (SELECT COUNT(*) FROM ${table('administration_task_registry_state')})=0 AS 'TASK_MIGRATION_STATE_NOT_EMPTY';
    ${Object.keys(CONTRACTS).filter(n => n !== 'administration_task_registry_state').map(n => `ASSERT (SELECT COUNT(*) FROM ${table(n)})=0 AS 'TASK_MIGRATION_TARGET_NOT_EMPTY';`).join('\n')}
    ASSERT (SELECT COUNT(*) FROM ${table('management_dossiers')} WHERE tenant_id='2sg' AND dossier_id='GD-006' AND portfolio_id='PORT-2SG-GLOBAL' AND status='active' AND confidentiality='internal' AND record_status='validated_for_integration')=1 AS 'TASK_MIGRATION_PARENT_CHANGED';
    ASSERT (SELECT COUNT(*) FROM ${table('management_portfolios')} WHERE tenant_id='2sg' AND portfolio_id='PORT-2SG-GLOBAL' AND status='active' AND confidentiality='internal' AND function_id='management_governance')=1 AS 'TASK_MIGRATION_PORTFOLIO_CHANGED';
    INSERT INTO ${table('administration_task_registry_state')} (id,revision,contract_version) VALUES ('registry',0,${literal(TASK_EXECUTION_CONTRACT_VERSION)});
    ${Object.entries(rows).flatMap(([name, records]) => records.map(r => insert(name, r))).join('\n')}
    INSERT INTO ${table('administration_audit_log')} (id,tenant_id,actor_user_id,actor_name,entity_type,entity_id,action,event_at,metadata_json)
      VALUES (${literal('AUD-'+REGISTRATION)},'2sg',@actor,NULL,'task_catalogue',${literal(PROJECT_ID)},'create',CURRENT_TIMESTAMP(),${literal(JSON.stringify({ registration: REGISTRATION, approval_sha256: DECISION_SHA256, historical_import: false }))});
    COMMIT TRANSACTION;`;
  return { target: TARGET, registration: REGISTRATION, projectId: PROJECT_ID, rows,
    createStatements: buildTaskActivationSchemaProposal(TARGET).proposed_statements, registrationSql: sql };
}
module.exports = { TARGET, CONTRACTS, PROJECT_ID, REGISTRATION, assertNativeTable, registrationRows, buildApprovedTaskMigration };

'use strict';

const { buildFinancialOperationRegistrationPreparation } = require('./taskFinancialOperationReferences');
const field = (name, type = 'STRING', mode = 'REQUIRED') => ({ name, type, mode });

// Describes a possible extension only. No cloud calls or writes.
function buildFinancialStoragePlanCandidate() {
  const draft = buildFinancialOperationRegistrationPreparation();
  return {
    status: 'local_design_for_review', application_allowed: false, activation_allowed: false,
    target: { project: 'mon-projet-data-2sg', dataset: 'm3s_2sg', location: 'US' },
    tables: [
      { candidate_name: 'management_operational_plans', purpose: 'governed operational plans',
        fields: [field('id'), field('tenant_id'), field('source_key'), field('label'), field('portfolio_id'),
          field('dossier_id', 'STRING', 'NULLABLE'), field('function_id'), field('governance_status'),
          field('status'), field('registration_reference'), field('decision_reference'),
          field('decision_version'), field('decision_sha256'), field('created_at', 'TIMESTAMP'),
          field('updated_at', 'TIMESTAMP')], clustering: ['tenant_id', 'source_key'], partition_field: null },
      { candidate_name: 'management_operational_assignments', purpose: 'actor assignments to operational plans',
        fields: [field('id'), field('tenant_id'), field('source_key'), field('operational_plan_id'),
          field('actor_user_id'), field('assignee_agent_id'), field('team_id'), field('function_id'),
          field('module'), field('governance_status'), field('status'), field('registration_reference'),
          field('created_at', 'TIMESTAMP'), field('updated_at', 'TIMESTAMP')],
        clustering: ['tenant_id', 'operational_plan_id', 'actor_user_id'], partition_field: null }
    ],
    prepared_plan: draft.plan,
    prepared_assignment: draft.assignment,
    existing_evidence: {
      kind: 'codex_conversation', thread: '019e5f3c-255a-77b0-aa41-2931fa3d3830',
      validation_messages: ['01a18903-3ff7-75b1-be3d-983021a448cf', '01a18913-0618-7d73-a553-2f342d00ff26'],
      consultation_correspondence: 'COR-4727d349-ab86-4386-84e4-256f3a11abdc',
      railway_correspondence: draft.source.reference,
      local_excerpt_sha256: 'a3e2b951bb1c8d937e09f3b02ca9952e3414bcab73c566ff0c75a3c5e481f987',
      local_encrypted_backup_id: 'LOCAL-OUTILS-DOCS-20261029T220832Z',
      durable_server_version_created: false, server_verifier_connected: false
    },
    concurrency_candidate: {
      existing_fence: 'administration_task_registry_state',
      approach: 'transaction_fence_then_duplicate_checks_then_registration_and_audit',
      applies_only_if_all_writers_cooperate: true,
      prevents_external_append: false,
      verified_in_production: false
    },
    gates: [
      'confirm_destination_schema_and_no_existing_equivalent',
      'verify_table_and_partition_retention_before_and_after_creation',
      'protected_backup_and_restore_check',
      'review_faithful_evidence_and_qualify_durable_version_and_access',
      'verify_actor_identity_existing_permissions_and_decision_status',
      'check_source_and_business_duplicates_and_concurrent_creation',
      'validate_reader_and_fail_closed_without_verified_authority',
      'agree_rollback_preserving_records_and_history',
      'separate_approval_for_creation_and_activation'
    ],
    exclusions: ['create_or_modify_cloud_resources', 'create_tasks', 'import_documents',
      'modify_existing_data', 'modify_permissions', 'create_expense', 'automatic_execution']
  };
}

// SQL is provided for review and explicit dry runs only; this function never executes it.
function buildFinancialSchemaPreview() {
  const candidate = buildFinancialStoragePlanCandidate();
  const { project, dataset } = candidate.target;
  const statements = candidate.tables.map(table => {
    const columns = table.fields.map(({ name, type, mode }) =>
      `  \`${name}\` ${type}${mode === 'REQUIRED' ? ' NOT NULL' : ''}`);
    return {
      table: table.candidate_name,
      sql: `CREATE TABLE \`${project}.${dataset}.${table.candidate_name}\` (\n${columns.join(',\n')}\n)\nCLUSTER BY ${table.clustering.map(name => `\`${name}\``).join(', ')};`
    };
  });
  return { status: 'review_only', application_allowed: false, cloud_access: false, statements };
}

// Preview only. Server authority and GED checks must succeed before any execution.
function buildFinancialRegistrationPreview() {
  const table = name => `\`mon-projet-data-2sg.m3s_2sg.${name}\``;
  const ids = Object.freeze({ plan: 'PLAN-FIN-2SG-20261029', assignment: 'AFF-FIN-2SG-20261029-MANAGER',
    planSource: 'finance/operational-plan/2026-10-29', assignmentSource: 'finance/operational-plan/2026-10-29/manager',
    registration: 'REG-FIN-2SG-20261029-001' });
  const sql = `BEGIN TRANSACTION;
    UPDATE ${table('administration_task_registry_state')} SET revision=revision+1
      WHERE id='registry' AND contract_version=@contract_version;
    ASSERT @@row_count=1 AS 'FINANCE_REGISTRY_UNAVAILABLE';
    ASSERT (SELECT COUNT(*) FROM ${table('management_portfolios')} WHERE tenant_id='2sg'
      AND portfolio_id='PORT-2SG-GLOBAL' AND function_id='management_governance'
      AND status='active' AND confidentiality='internal')=1 AS 'FINANCE_PORTFOLIO_CHANGED';
    ASSERT (SELECT COUNT(*) FROM ${table('administration_correspondence')} WHERE tenant_id='2sg'
      AND id='COR-de403d44-4f7d-4926-ba0d-f3ac6e20687f' AND direction='incoming'
      AND deleted_at IS NULL)=1 AS 'FINANCE_CONSULTATION_UNAVAILABLE';
    ASSERT (SELECT COUNT(*) FROM ${table('administration_correspondence')} WHERE tenant_id='2sg'
      AND id='COR-88832bd5-2231-42f3-a7d6-4f4e13a8cbe3' AND direction='internal'
      AND confidentiality IN ('internal','public') AND deleted_at IS NULL
      AND status IN ('to_qualify','to_file_dms','in_progress','closed'))=1 AS 'FINANCE_SOURCE_UNAVAILABLE';
    ASSERT (SELECT COUNT(*) FROM ${table('management_task_assignments')} WHERE tenant_id='2sg'
      AND actor_user_id=@actor AND assignee_agent_id='PER-2SG-0001' AND team_id='TZH'
      AND governance_status='approved' AND status='active')=1 AS 'FINANCE_ACTOR_UNQUALIFIED';
    ASSERT (SELECT COUNT(*) FROM ${table('management_operational_plans')} WHERE tenant_id='2sg'
      AND (id=@plan_id OR source_key=@plan_source OR LOWER(TRIM(label))=LOWER(TRIM(@label))))=0
      AS 'FINANCE_PLAN_DUPLICATE';
    ASSERT (SELECT COUNT(*) FROM ${table('management_operational_assignments')} WHERE tenant_id='2sg'
      AND (id=@assignment_id OR source_key=@assignment_source OR operational_plan_id=@plan_id))=0
      AS 'FINANCE_ASSIGNMENT_DUPLICATE';
    INSERT INTO ${table('management_operational_plans')}
      (id,tenant_id,source_key,label,portfolio_id,dossier_id,function_id,governance_status,status,
       registration_reference,decision_reference,decision_version,decision_sha256,created_at,updated_at)
    VALUES (@plan_id,'2sg',@plan_source,@label,'PORT-2SG-GLOBAL',NULL,'finance','approved','active',
      @registration,@decision_reference,@decision_version,@decision_sha256,CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP());
    INSERT INTO ${table('management_operational_assignments')}
      (id,tenant_id,source_key,operational_plan_id,actor_user_id,assignee_agent_id,team_id,function_id,module,
       governance_status,status,registration_reference,created_at,updated_at)
    VALUES (@assignment_id,'2sg',@assignment_source,@plan_id,@actor,'PER-2SG-0001','TZH','finance','FINANCES',
      'approved','active',@registration,CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP());
    INSERT INTO ${table('administration_audit_log')}
      (id,tenant_id,actor_user_id,actor_name,entity_type,entity_id,action,event_at,metadata_json)
    VALUES (@audit_id,'2sg',@actor,NULL,'operational_plan',@plan_id,'create',CURRENT_TIMESTAMP(),@audit_metadata);
    INSERT INTO ${table('administration_audit_log')}
      (id,tenant_id,actor_user_id,actor_name,entity_type,entity_id,action,event_at,metadata_json)
    VALUES (CONCAT(@audit_id,'-assignment'),'2sg',@actor,NULL,'operational_assignment',@assignment_id,
      'create',CURRENT_TIMESTAMP(),@audit_metadata);
    COMMIT TRANSACTION;`;
  return { status: 'preview_only', executable: false, ids, sql,
    pending: ['fresh_backup_and_restore_check', 'server_authority_and_ged_verified', 'authenticated_actor_binding',
      'schema_retention_and_duplicates', 'concurrency_review_external_writers', 'rollback_and_post_write_verification'] };
}

module.exports = { buildFinancialStoragePlanCandidate, buildFinancialSchemaPreview, buildFinancialRegistrationPreview };

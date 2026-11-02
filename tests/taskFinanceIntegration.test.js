'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskRegistryHandlers, TASK_TABLE_CONTRACTS } = require('../taskRegistry');
const { PERMISSIONS, ADMINISTRATION_TABLE_CONTRACTS } = require('../administrationRegistries');
const { createFinancialReferenceBridgeCandidate, createFinancialSourceForActorCandidate } = require('../taskFinancialReferenceBridgeCandidate');
const { buildFinancialRegistrationPreview, buildFinancialStoragePlanCandidate, FINANCE_DECISION_SHA256 } = require('../taskFinancialStoragePlanCandidate');
const { RAILWAY_SOURCE } = require('../taskFinancialOperationReferences');

test('native finance bridge reaches the task transaction with the approved plan and assignment', async () => {
  const ids = buildFinancialRegistrationPreview().ids, design = buildFinancialStoragePlanCandidate();
  const plan = { id: ids.plan, source_key: ids.planSource, label: design.prepared_plan.label, tenant_id: '2sg',
    portfolio_id: 'PORT-2SG-GLOBAL', dossier_id: null, function_id: 'finance', governance_status: 'approved',
    status: 'active', registration_reference: ids.registration, decision_reference: FINANCE_DECISION_SHA256,
    decision_sha256: FINANCE_DECISION_SHA256, decision_version: '0' };
  const assignment = { id: ids.assignment, source_key: ids.assignmentSource, tenant_id: '2sg',
    operational_plan_id: ids.plan, actor_user_id: 'fixture-user', assignee_agent_id: 'PER-2SG-0001',
    team_id: 'TZH', function_id: 'finance', module: 'FINANCES', governance_status: 'approved',
    status: 'active', registration_reference: ids.registration };
  const contracts = { ...TASK_TABLE_CONTRACTS, administration_audit_log: ADMINISTRATION_TABLE_CONTRACTS.administration_audit_log,
    administration_correspondence: ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence,
    ...Object.fromEntries(design.tables.map(t => [t.candidate_name, t])) };
  const calls = [];
  const bigquery = {
    dataset: () => ({ table: name => ({ getMetadata: async () => { const c = contracts[name]; return [{
      type: 'TABLE', schema: { fields: c.fields }, clustering: { fields: c.clustering },
      ...(c.partitionField ? { timePartitioning: { type: 'DAY', field: c.partitionField } } : {}) }]; } }) }),
    query: async options => {
      calls.push(options);
      const { query, params } = options;
      if (query.includes("COUNTIF(id='registry'")) return [[{ total: 1, valid: 1, invalid_task_versions: 0 }]];
      if (query.startsWith('SELECT revision,contract_version FROM')) return [[{ revision: 12, contract_version: 'm3s.task-execution.v2' }]];
      if (query.includes('.management_operational_plans`') && !query.includes('BEGIN TRANSACTION')) return [[plan]];
      if (query.includes('.management_operational_assignments`') && !query.includes('BEGIN TRANSACTION')) return [[assignment]];
      if (query.includes('.management_portfolios`') && !query.includes('BEGIN TRANSACTION')) return [[{ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL',
        function_id: 'management_governance', status: 'active', confidentiality: 'internal', source_ref: 'fixture-proof' }]];
      if (query.includes('.administration_correspondence`') && !query.includes('BEGIN TRANSACTION')) return [[{
        id: RAILWAY_SOURCE, tenant_id: '2sg', direction: 'internal', confidentiality: 'internal', status: 'in_progress', not_deleted: true }]];
      if (query.startsWith('SELECT id FROM (')) return [[]];
      if (query.includes('BEGIN TRANSACTION')) {
        const { tenant_id, owner_user_id, reference_key, context_key, source_identity, payload_hash,
          audit_id, event_at, metadata_json, ...data } = params;
        return [[{ ...data, reference: params.reference, source_kind: 'operational', revision: 1,
          can_edit: true, source_start_date: null, source_due_date: null, created_at: event_at,
          updated_at: event_at, replayed: false }]];
      }
      throw Error('unexpected synthetic query');
    }
  };
  const sourceForActor = createFinancialSourceForActorCandidate({ bigquery, projectId: 'fixture-project', datasetId: 'fixture_dataset',
    canReadFinance: async () => true, loadPerson: async () => ({ id: 'PER-2SG-0001', team_id: 'TZH', label: 'Synthetic', active: true }) });
  const referenceSource = createFinancialReferenceBridgeCandidate({ enabled: true, financialSourceForActor: sourceForActor,
    standardSource: { inspectForActor: async () => ({}), bindForActor: async () => null } });
  const handlers = createTaskRegistryHandlers({ bigquery, projectId: 'fixture-project', datasetId: 'fixture_dataset',
    historicalTenantId: '2sg', referenceSource, now: () => '2026-11-02T00:00:00Z', logger: { warn() {} } });
  const user = { id: 'fixture-user', tenantId: '2sg', role: 'Manager', permissions: [PERMISSIONS.RESOURCES_READ,
    PERMISSIONS.RESOURCES_WRITE, PERMISSIONS.CORRESPONDENCE_READ] };
  const body = { contract_version: 'm3s.task-execution.v2', reference: 'FIN-TEST-01', title: 'Tâche fictive',
    description: null, expected_result: 'Résultat fictif', verification_criterion: null, status: 'to_do', priority: 'normal',
    module: 'FINANCES', assignee_agent_id: 'PER-2SG-0001', team_id: 'TZH', function_id: 'finance', progression: null,
    planned_start_date: null, due_date: null, actual_start_date: null, actual_end_date: null,
    execution_context: { execution_kind: 'operation', phase_id: null, activity_id: null,
      operational_plan_id: ids.plan, recurrence_id: null, occurrence_key: null }, source_links: [],
    source_origin: { kind: 'correspondence', reference: RAILWAY_SOURCE } };
  const call = async () => { const res = { statusCode: 200, set() { return this; }, status(v) { this.statusCode = v; return this; },
    json(v) { this.body = v; return this; } };
    await handlers.create({ user, body, query: { contract_version: body.contract_version }, params: {} }, res); return res; };
  const result = await call();
  assert.equal(result.statusCode, 201, JSON.stringify({ code: result.body?.code, queries: calls.map(c => c.query.slice(0, 100)) }));
  const tx = calls.find(c => c.query.includes('BEGIN TRANSACTION'));
  assert.ok(tx);
  assert.equal(tx.params.finance_observed_revision, 12);
  assert.equal(tx.params.finance_assignment_source, ids.assignmentSource);
  assert.match(tx.query, /a\.source_key=@finance_assignment_source/);
  assert.match(tx.query, /p\.status='active'/);
  assert.equal(calls.filter(c => c.query.includes('.management_operational_plans`') && !c.query.includes('BEGIN TRANSACTION')).length, 4);
  plan.status = 'inactive';
  const previousTransactions = calls.filter(c => c.query.includes('BEGIN TRANSACTION')).length;
  assert.notEqual((await call()).statusCode, 201);
  assert.equal(calls.filter(c => c.query.includes('BEGIN TRANSACTION')).length, previousTransactions);
});

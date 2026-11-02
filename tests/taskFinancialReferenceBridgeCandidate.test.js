'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinancialReferenceBridgeCandidate, createFinancialSourceForActorCandidate } = require('../taskFinancialReferenceBridgeCandidate');
const { PERMISSIONS } = require('../administrationRegistries');
const { RAILWAY_SOURCE } = require('../taskFinancialOperationReferences');
const { createNativeFinancialSourceCandidate } = require('../taskFinancialOperationReferences');
const { createFinancialDecisionVerifierCandidate, createPinnedFinancialAuthorityCandidate } = require('../taskFinancialDecisionSourceCandidate');
const { buildFinancialStoragePlanCandidate } = require('../taskFinancialStoragePlanCandidate');
const { ADMINISTRATION_TABLE_CONTRACTS } = require('../administrationRegistries');
const { scopeFor, digest } = require('../gedPrivatePolicy');

function fixture() {
  const base = { inspectForActor: async () => ({ writes_enabled: false, choices: { phases: [], activities: [],
    operational_plans: [], assignments: [], recurrences: [] } }), bindForActor: async () => null };
  const governed = id => ({ id, tenant_id: '2sg', governance_status: 'approved', status: 'active', registration_reference: 'proof' });
  const plan = { ...governed('plan-test'), label: 'Finance', portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'finance' };
  const assignment = { ...governed('assignment-test'), operational_plan_id: plan.id, actor_user_id: 'actor-test',
    assignee_agent_id: 'person-test', team_id: 'team-test', function_id: 'finance', module: 'FINANCES' };
  const source = { load: async () => ({ plan, assignment, portfolio: governed('PORT-2SG-GLOBAL'),
    person: { id: 'person-test', team_id: 'team-test', label: 'Test Person', active: true } }),
    readCorrespondence: async () => ({ id: RAILWAY_SOURCE, tenant_id: '2sg', direction: 'internal',
      confidentiality: 'internal', status: 'in_progress', not_deleted: true }), verifyDecision: async () => true };
  const actor = { tenantId: '2sg', actorId: 'actor-test', permissions: [PERMISSIONS.RESOURCES_READ,
    PERMISSIONS.RESOURCES_WRITE, PERMISSIONS.CORRESPONDENCE_READ] };
  return { base, source, actor, plan, assignment };
}

test('financial bridge is disabled by default and never changes the standard result', async () => {
  const f = fixture();
  const bridge = createFinancialReferenceBridgeCandidate({ standardSource: f.base });
  assert.deepEqual(await bridge.inspectForActor(f.actor), await f.base.inspectForActor(f.actor));
  assert.equal(await bridge.bindForActor(f.actor), null);
});

test('financial bridge connects a qualified operational plan without allowing a project fallback', async () => {
  const f = fixture();
  const bridge = createFinancialReferenceBridgeCandidate({ standardSource: f.base, enabled: true,
    financialSourceForActor: async () => f.source });
  const inspect = await bridge.inspectForActor(f.actor);
  assert.equal(inspect.choices.operational_plans[0].id, f.plan.id);
  assert.equal(inspect.choices.operational_plans[0].function_id, 'finance');
  assert.equal(inspect.source_origins.filter(origin => origin.reference === RAILWAY_SOURCE).length, 1);
  assert.equal(inspect.execution_catalogue_ready, true);
  assert.equal(inspect.activation_enabled, true);
  assert.equal(inspect.finance_activation_enabled, true);
  assert.equal(inspect.standardisation_writes_enabled, false);
  assert.equal(inspect.writes_enabled, true);
  const bound = await bridge.bindForActor(f.actor);
  const context = { execution_kind: 'operation', operational_plan_id: f.plan.id };
  assert.equal((await bound.resolveAssignment({ ...f.assignment, context })).id, f.assignment.id);
  assert.equal(await bound.resolveAssignment({ ...f.assignment, context: { execution_kind: 'project' } }), null);
  f.source.verifyDecision = async () => false;
  assert.equal(await bound.catalogue.get('operational_plan', f.plan.id, '2sg'), null);
});

test('financial bridge refuses missing permissions or an unavailable decision source', async () => {
  const f = fixture();
  const bridge = createFinancialReferenceBridgeCandidate({ standardSource: f.base, enabled: true,
    financialSourceForActor: async () => f.source });
  assert.equal(await bridge.bindForActor({ ...f.actor, permissions: [PERMISSIONS.RESOURCES_READ] }), null);
  f.source.verifyDecision = async () => false;
  assert.equal(await bridge.bindForActor(f.actor), null);
});

test('end-to-end candidate composes pinned native authority, scoped GED and the operational task bridge', async () => {
  const f = fixture();
  const bytes = Buffer.from('%PDF-1.4\nsynthetic decision only');
  const hash = digest(bytes);
  const policy = { owner: { userId: 'actor-test', organizationId: '2sg' },
    documents: [{ name: 'fictional.pdf', category: 'finance', sha256: hash, size: bytes.length }] };
  const principal = { id: 'actor-test', tenantId: '2sg', authProvider: 'google' };
  const scope = scopeFor(policy, principal);
  const event = { revision: 0, current_document_id: hash, trashed: false };
  const register = { lifecycle: { history: async () => [event] }, read: async () => ({ tenant: scope.tenant,
    owner_id: scope.owner, document_id: hash, byte_size: bytes.length, generation: '123' }) };
  const storage = { get: async () => bytes };
  Object.assign(f.plan, { source_key: 'finance/plan-test', decision_reference: hash,
    decision_sha256: hash, decision_version: '0' });
  const contracts = Object.fromEntries(buildFinancialStoragePlanCandidate().tables.map(t => [t.candidate_name, t]));
  contracts.administration_correspondence = ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence;
  const bigquery = {
    dataset: () => ({ table: name => ({ getMetadata: async () => { const c = contracts[name]; return [{ type: 'TABLE',
      schema: { fields: c.fields }, clustering: { fields: c.clustering },
      ...(c.partitionField ? { timePartitioning: { type: 'DAY', field: c.partitionField } } : {}) }]; } }) }),
    query: async ({ query }) => {
      if (query.includes('.management_operational_plans`')) return [[f.plan]];
      if (query.includes('.management_operational_assignments`')) return [[f.assignment]];
      if (query.includes('.management_portfolios`')) return [[{ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL',
        function_id: 'management_governance', status: 'active', confidentiality: 'internal', source_ref: 'proof' }]];
      if (query.includes('.administration_correspondence`')) return [[await f.source.readCorrespondence()]];
      throw Error('unexpected query');
    }
  };
  const authority = createPinnedFinancialAuthorityCandidate({ bigquery, projectId: 'test-project', datasetId: 'test_dataset',
    policy, principal, actorId: f.actor.actorId, contract: contracts.management_operational_plans,
    anchor: { planId: f.plan.id, registration: 'proof', sha256: hash, revision: 0 } });
  const verifyDecision = createFinancialDecisionVerifierCandidate({ policy, principal, register, storage, authority });
  const source = createNativeFinancialSourceCandidate({ bigquery, projectId: 'test-project', datasetId: 'test_dataset',
    planSourceKey: 'finance/plan-test', loadPerson: async () => ({ id: 'person-test', team_id: 'team-test',
      label: 'Test Person', active: true }), verifyDecision });
  const bridge = createFinancialReferenceBridgeCandidate({ standardSource: f.base, enabled: true,
    financialSourceForActor: async () => source });
  const bound = await bridge.bindForActor(f.actor);
  assert.ok(bound);
  assert.equal(bound.financialWriteGuard.planSourceKey, 'finance/plan-test');
  assert.equal(bound.financialWriteGuard.decisionSha256, hash);
  assert.equal(bound.financialWriteGuard.portfolioRegistration, 'proof');
  assert.equal((await bound.catalogue.get('operational_plan', f.plan.id, '2sg')).id, f.plan.id);
  event.trashed = true;
  assert.equal(await bound.catalogue.get('operational_plan', f.plan.id, '2sg'), null);
  assert.equal(await bridge.bindForActor(f.actor), null);
});

test('finance source factory refuses a different principal or missing Finance permission before GED access', async () => {
  let calls = 0;
  const sourceForActor = createFinancialSourceForActorCandidate({ bigquery: {}, projectId: 'test-project', datasetId: 'test_dataset',
    loadPerson: async () => null, canReadFinance: async () => false,
    getGedServices: async () => { calls++; throw Error('must not be called'); } });
  const actor = { tenantId: '2sg', actorId: 'actor-test', principal: { id: 'actor-test', tenantId: '2sg', authProvider: 'google' } };
  await assert.rejects(sourceForActor(actor), /ACCESS_DENIED/);
  await assert.rejects(sourceForActor({ ...actor, actorId: 'different' }), /ACCESS_DENIED/);
  assert.equal(calls, 0);
});

test('registered finance plan uses its native status without accessing GED', async () => {
  const f = fixture();
  const { FINANCE_DECISION_SHA256, buildFinancialRegistrationPreview } = require('../taskFinancialStoragePlanCandidate');
  const ids = buildFinancialRegistrationPreview().ids;
  Object.assign(f.plan, { id: ids.plan, source_key: ids.planSource, label: buildFinancialStoragePlanCandidate().prepared_plan.label,
    registration_reference: ids.registration,
    decision_reference: FINANCE_DECISION_SHA256, decision_sha256: FINANCE_DECISION_SHA256, decision_version: '0' });
  Object.assign(f.assignment, { id: ids.assignment, source_key: ids.assignmentSource, operational_plan_id: ids.plan, registration_reference: ids.registration,
    assignee_agent_id: 'PER-2SG-0001', team_id: 'TZH' });
  const contracts = Object.fromEntries(buildFinancialStoragePlanCandidate().tables.map(t => [t.candidate_name, t]));
  contracts.administration_correspondence = ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence;
  const bigquery = {
    dataset: () => ({ table: name => ({ getMetadata: async () => { const c = contracts[name]; return [{ type: 'TABLE',
      schema: { fields: c.fields }, clustering: { fields: c.clustering },
      ...(c.partitionField ? { timePartitioning: { type: 'DAY', field: c.partitionField } } : {}) }]; } }) }),
    query: async ({ query }) => {
      if (query.includes('.management_operational_plans`')) return [[f.plan]];
      if (query.includes('.management_operational_assignments`')) return [[f.assignment]];
      if (query.includes('.management_portfolios`')) return [[{ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL',
        function_id: 'management_governance', status: 'active', confidentiality: 'internal', source_ref: 'proof' }]];
      if (query.includes('.administration_correspondence`')) return [[await f.source.readCorrespondence()]];
      throw Error('unexpected query');
    }
  };
  let gedCalls = 0;
  const sourceForActor = createFinancialSourceForActorCandidate({ bigquery, projectId: 'test-project', datasetId: 'test_dataset',
    getGedServices: async () => { gedCalls++; throw Error('unexpected GED access'); },
    canReadFinance: async () => true, loadPerson: async () => ({ id: 'PER-2SG-0001',
      team_id: 'TZH', label: 'Synthetic Person', active: true }) });
  f.actor.principal = { id: f.actor.actorId, tenantId: '2sg', authProvider: 'google' };
  const bridge = createFinancialReferenceBridgeCandidate({ standardSource: f.base, enabled: true,
    financialSourceForActor: sourceForActor });
  const bound = await bridge.bindForActor(f.actor);
  assert.ok(bound);
  assert.equal((await bound.catalogue.get('operational_plan', ids.plan, '2sg')).id, ids.plan);
  f.plan.status = 'inactive';
  assert.equal(await bound.catalogue.get('operational_plan', ids.plan, '2sg'), null);
  assert.equal(await bridge.bindForActor(f.actor), null);
  f.plan.status = 'active'; f.assignment.id = 'different-assignment';
  assert.equal(await bridge.bindForActor(f.actor), null);
  f.assignment.id = ids.assignment; f.plan.decision_sha256 = 'a'.repeat(64);
  assert.equal(await bridge.bindForActor(f.actor), null);
  f.plan.decision_sha256 = FINANCE_DECISION_SHA256; f.plan.label = 'Different purpose';
  assert.equal(await bridge.bindForActor(f.actor), null);
  f.plan.label = buildFinancialStoragePlanCandidate().prepared_plan.label; f.assignment.source_key = 'different/source';
  assert.equal(await bridge.bindForActor(f.actor), null);
  assert.equal(gedCalls, 0);
});

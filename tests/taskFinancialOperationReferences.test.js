'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinancialOperationReferenceReader, buildFinancialOperationRegistrationPreparation, createNativeFinancialSourceCandidate, RAILWAY_SOURCE } = require('../taskFinancialOperationReferences');
const { resolveTaskExecutionContext } = require('../taskExecutionContract');
const { PERMISSIONS, ADMINISTRATION_TABLE_CONTRACTS } = require('../administrationRegistries');
const { buildFinancialStoragePlanCandidate } = require('../taskFinancialStoragePlanCandidate');

const tenant = '2sg', actorId = 'test-actor';
const actor = { tenantId: tenant, actorId, permissions: [PERMISSIONS.RESOURCES_READ, PERMISSIONS.CORRESPONDENCE_READ] };
const base = id => ({ id, tenant_id: tenant, governance_status: 'approved', status: 'active', registration_reference: 'test-proof' });
function fixture() {
  const data = { portfolio: base('PORT-2SG-GLOBAL'),
    plan: { ...base('plan-test'), portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'finance', label: 'Finance' },
    assignment: { ...base('assignment-test'), operational_plan_id: 'plan-test', actor_user_id: actorId,
      assignee_agent_id: 'person-test', team_id: 'team-test', function_id: 'finance', module: 'FINANCES' },
    person: { id: 'person-test', label: 'Test Person', team_id: 'team-test', active: true } };
  let correspondence = { id: RAILWAY_SOURCE, tenant_id: tenant, direction: 'internal',
    confidentiality: 'internal', not_deleted: true, status: 'in_progress' };
  const source = { async load() { return data; }, async readCorrespondence() { return correspondence; },
    async verifyDecision() { return true; } };
  return { data, source, deleteSource() { correspondence = null; } };
}
const context = { execution_kind: 'operation', operational_plan_id: 'plan-test' };

test('governed financial plan and assignment resolve without a fictional project', async () => {
  const f = fixture();
  const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
  assert.ok(bound);
  const resolved = await resolveTaskExecutionContext(context, { tenantId: tenant, catalogue: bound.catalogue });
  assert.equal(resolved.project_id, null);
  assert.equal(resolved.function_id, 'finance');
  assert.equal((await bound.resolveAssignment({ ...f.data.assignment, context })).id, 'assignment-test');
  const link = { kind: 'correspondence', reference: RAILWAY_SOURCE };
  assert.equal(await bound.qualifySources({ source_links: [link], source_origin: link, context }), true);
  f.deleteSource();
  assert.equal(await bound.qualifySources({ source_links: [link], source_origin: link, context }), false);
});

test('missing plans, unapproved assignments and actors outside scope fail closed', async () => {
  for (const mutate of [d => { d.plan = null; }, d => { d.assignment.status = 'inactive'; },
    d => { d.assignment.actor_user_id = 'other'; }, d => { d.assignment.function_id = 'other'; },
    d => { d.person.team_id = 'other'; }, d => { d.plan.tenant_id = 'other'; }]) {
    const f = fixture(); mutate(f.data);
    assert.equal(await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor), null);
  }
  const f = fixture();
  assert.equal(await createFinancialOperationReferenceReader({ source: f.source }).bindForActor({ ...actor, permissions: [] }), null);
  assert.equal(await createFinancialOperationReferenceReader({ source: f.source }).bindForActor({ ...actor, tenantId: 'other' }), null);
});

test('a revoked assignment is not reused from an earlier binding', async () => {
  const f = fixture();
  const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
  const link = { kind: 'correspondence', reference: RAILWAY_SOURCE };
  f.data.assignment.status = 'inactive';
  assert.equal(await bound.resolveAssignment({ ...f.data.assignment, context }), null);
  assert.equal(await bound.qualifySources({ source_links: [link], source_origin: link, context }), false);
});

test('catalogue refuses a replaced revoked plan or unavailable source', async () => {
  const f = fixture();
  const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
  assert.ok(bound);
  f.data.plan = { ...f.data.plan, status: 'inactive' };
  assert.equal(await bound.catalogue.get('operational_plan', 'plan-test', tenant), null);
  await assert.rejects(resolveTaskExecutionContext(context, { tenantId: tenant, catalogue: bound.catalogue }),
    /TASK_CONTEXT_REFERENCE_UNQUALIFIED/);

  f.source.load = async () => { throw new Error('source unavailable'); };
  assert.equal(await bound.catalogue.get('portfolio', 'PORT-2SG-GLOBAL', tenant), null);
});

test('a changed plan label invalidates the previous catalogue and assignment binding', async () => {
  const f = fixture();
  const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
  assert.ok(bound);
  assert.equal(bound.choices.operational_plans[0].label, 'Finance');
  f.data.plan.label = 'Different plan';
  assert.equal(await bound.catalogue.get('operational_plan', 'plan-test', tenant), null);
  assert.equal(await bound.resolveAssignment({ ...f.data.assignment, context }), null);
  const renewed = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
  assert.equal(renewed.choices.operational_plans[0].label, 'Different plan');
});

test('financial source qualification refuses a different origin or additional unrelated link', async () => {
  const f = fixture();
  const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
  const allowed = { kind: 'correspondence', reference: RAILWAY_SOURCE };
  const other = { kind: 'correspondence', reference: 'COR-other' };
  assert.equal(await bound.qualifySources({ source_links: [allowed], source_origin: other, context }), false);
  assert.equal(await bound.qualifySources({ source_links: [allowed, other], source_origin: allowed, context }), false);
});

test('finance reader enforces the approved portfolio and function', async () => {
  const valid = fixture();
  assert.ok(await createFinancialOperationReferenceReader({ source: valid.source }).bindForActor(actor));
  for (const mutate of [
    d => { d.plan.function_id = 'other-function'; d.assignment.function_id = 'other-function'; },
    d => { d.plan.portfolio_id = 'portfolio-other'; d.portfolio.id = 'portfolio-other'; },
    d => { d.plan.portfolio_id = 'portfolio-other'; },
    d => { d.portfolio.id = 'portfolio-other'; }
  ]) {
    const f = fixture(); mutate(f.data);
    assert.equal(await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor), null);
  }
});

test('finance reader rejects a portfolio or function changed after binding', async () => {
  for (const mutate of [
    d => { d.plan.function_id = 'other-function'; d.assignment.function_id = 'other-function'; },
    d => { d.plan.portfolio_id = 'portfolio-other'; d.portfolio.id = 'portfolio-other'; }
  ]) {
    const f = fixture();
    const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
    assert.ok(bound); mutate(f.data);
    assert.equal(await bound.catalogue.get('operational_plan', 'plan-test', tenant), null);
    assert.equal(await bound.resolveAssignment({ ...f.data.assignment, context }), null);
  }
});

test('financial assignment supplies only a verified current display name', async () => {
  const f = fixture();
  const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
  assert.equal(bound.choices.assignments[0].label, 'Test Person');
  assert.equal((await bound.resolveAssignment({ ...f.data.assignment, context })).agent_display_name, 'Test Person');
  f.data.person.label = 'Another Person';
  assert.equal(await bound.resolveAssignment({ ...f.data.assignment, context }), null);

  const invalid = fixture();
  invalid.data.person.label = 'Test\nPerson';
  assert.equal(await createFinancialOperationReferenceReader({ source: invalid.source }).bindForActor(actor), null);
});

test('prepared native financial references are non-executable and carry no generated IDs', async () => {
  const proposal = buildFinancialOperationRegistrationPreparation();
  assert.deepEqual(proposal.statements, []);
  assert.equal(proposal.application_allowed, false);
  assert.ok(proposal.pending.includes('backup_review_and_respect_existing_activation_approval'));
  assert.ok(!proposal.pending.includes('backup_review_and_separate_activation_authorisation'));
  for (const row of [proposal.plan, proposal.assignment]) {
    assert.equal(row.id, null);
    assert.equal(row.registration_reference, null);
    assert.equal(row.status, 'inactive');
    assert.equal(row.governance_status, 'prepared_not_registered');
    assert.equal(row.function_id, 'finance');
  }
  assert.equal(proposal.assignment.actor_user_id, null);
  assert.equal(proposal.consultation.status, 'response_recorded');
  assert.ok(proposal.pending.includes('verify_consultation_reference_available_at_registration'));
  assert.equal(proposal.consultation.correspondence_reference, 'COR-de403d44-4f7d-4926-ba0d-f3ac6e20687f');
  assert.equal(proposal.consultation.access_granted, false);
  let sourceReads = 0;
  const source = { async load() { return { ...proposal, portfolio: null }; },
    async readCorrespondence() { sourceReads++; return null; } };
  assert.equal(await createFinancialOperationReferenceReader({ source }).bindForActor(actor), null);
  assert.equal(sourceReads, 0);
});

test('decision verification is mandatory and unavailable or rejected decisions fail closed', async () => {
  for (const verifyDecision of [undefined, async () => false, async () => { throw Error('unavailable'); }]) {
    const f = fixture(); f.source.verifyDecision = verifyDecision;
    assert.equal(await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor), null);
  }
});

test('decision is rechecked before subsequent catalogue, assignment and source access', async () => {
  const f = fixture(); let permitted = true;
  f.source.verifyDecision = async () => permitted;
  const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
  assert.ok(bound); permitted = false;
  const link = { kind: 'correspondence', reference: RAILWAY_SOURCE };
  assert.equal(await bound.catalogue.get('operational_plan', 'plan-test', tenant), null);
  assert.equal(await bound.resolveAssignment({ ...f.data.assignment, context }), null);
  assert.equal(await bound.qualifySources({ source_links: [link], source_origin: link, context }), false);
});

test('a changed decision identity, version or digest invalidates the existing finance binding', async () => {
  for (const field of ['decision_reference', 'decision_version', 'decision_sha256']) {
    const f = fixture();
    Object.assign(f.data.plan, { decision_reference: 'decision-test', decision_version: 'version-1', decision_sha256: 'a'.repeat(64) });
    const bound = await createFinancialOperationReferenceReader({ source: f.source }).bindForActor(actor);
    assert.ok(bound);
    f.data.plan[field] = field === 'decision_sha256' ? 'b'.repeat(64) : 'changed';
    const link = { kind: 'correspondence', reference: RAILWAY_SOURCE };
    assert.equal(await bound.catalogue.get('operational_plan', 'plan-test', tenant), null, field);
    assert.equal(await bound.resolveAssignment({ ...f.data.assignment, context }), null, field);
    assert.equal(await bound.qualifySources({ source_links: [link], source_origin: link, context }), false, field);
  }
});

function nativeSourceFixture() {
  const f = fixture();
  const plan = { ...f.data.plan, source_key: 'finance/plan-test' };
  const assignment = f.data.assignment;
  const contracts = Object.fromEntries(buildFinancialStoragePlanCandidate().tables.map(t => [t.candidate_name, t]));
  contracts.administration_correspondence = ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence;
  const metadata = name => {
    const c = contracts[name];
    return { type: 'TABLE', schema: { fields: c.fields }, clustering: { fields: c.clustering },
      ...(c.partitionField ? { timePartitioning: { type: 'DAY', field: c.partitionField } } : {}) };
  };
  const rows = { plans: [plan], assignments: [assignment], portfolios: [{ tenant_id: tenant,
    portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'management_governance', status: 'active',
    confidentiality: 'internal', source_ref: 'test-proof' }], correspondence: [{ id: RAILWAY_SOURCE,
    tenant_id: tenant, direction: 'internal', confidentiality: 'internal', status: 'in_progress', not_deleted: true }] };
  const bigquery = {
    dataset: () => ({ table: name => ({ getMetadata: async () => [metadata(name)] }) }),
    query: async ({ query, params }) => {
      assert.ok(params.tenant === tenant);
      if (query.includes('.management_operational_plans`')) return [rows.plans];
      if (query.includes('.management_operational_assignments`')) return [rows.assignments];
      if (query.includes('.management_portfolios`')) return [rows.portfolios];
      if (query.includes('.administration_correspondence`')) return [rows.correspondence];
      throw Error('unexpected query');
    }
  };
  const options = { bigquery, projectId: 'test-project', datasetId: 'test_dataset', planSourceKey: 'finance/plan-test',
    loadPerson: async () => f.data.person, verifyDecision: async () => true };
  return { rows, bigquery, options, metadata };
}

test('native financial source reads qualified existing rows through the existing finance reader', async () => {
  const f = nativeSourceFixture();
  const source = createNativeFinancialSourceCandidate(f.options);
  const bound = await createFinancialOperationReferenceReader({ source }).bindForActor(actor);
  assert.ok(bound);
  assert.equal(bound.choices.operational_plans[0].id, 'plan-test');
  assert.equal((await bound.resolveAssignment({ ...f.rows.assignments[0], context })).id, 'assignment-test');
});

test('native financial source rejects duplicate plans or assignments and expiring tables', async () => {
  for (const mutate of [
    f => { f.rows.plans.push({ ...f.rows.plans[0] }); },
    f => { f.rows.assignments.push({ ...f.rows.assignments[0] }); },
    f => { f.rows.portfolios[0].function_id = 'finance'; },
    f => { f.bigquery.dataset = () => ({ table: name => ({ getMetadata: async () => [{ ...f.metadata(name), expirationTime: '1' }] }) }); }
  ]) {
    const f = nativeSourceFixture(); mutate(f);
    const source = createNativeFinancialSourceCandidate(f.options);
    assert.equal(await createFinancialOperationReferenceReader({ source }).bindForActor(actor), null);
  }
});

test('native financial source accepts a valid opaque actor identity without granting another actor access', async () => {
  const f = nativeSourceFixture();
  f.rows.assignments[0].actor_user_id = 'google|synthetic-actor';
  const source = createNativeFinancialSourceCandidate(f.options);
  const reader = createFinancialOperationReferenceReader({ source });
  assert.ok(await reader.bindForActor({ ...actor, actorId: 'google|synthetic-actor' }));
  assert.equal(await reader.bindForActor({ ...actor, actorId: 'another-actor' }), null);
  assert.equal(await reader.bindForActor({ ...actor, actorId: 'bad\nactor' }), null);
});

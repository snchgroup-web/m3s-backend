'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { reviewFictionalDecisionSource, inspectGedDecisionDocument, createFinancialDecisionVerifierCandidate,
  createPinnedFinancialAuthorityCandidate } = require('../taskFinancialDecisionSourceCandidate');
const { scopeFor } = require('../gedPrivatePolicy');
const { createFinancialOperationReferenceReader, RAILWAY_SOURCE } = require('../taskFinancialOperationReferences');
const { PERMISSIONS } = require('../administrationRegistries');
const { buildFinancialStoragePlanCandidate } = require('../taskFinancialStoragePlanCandidate');

function fixture() {
  const bytes = Buffer.from('Fictional decision for testing only.');
  const decision = { id: 'decision-test', tenant_id: '2sg', operational_plan_id: 'plan-test',
    portfolio_id: 'PORT-2SG-GLOBAL', plan_function_id: 'finance',
    portfolio_function_id: 'management_governance', scope: 'cross_function_operational_plan',
    decider_person_id: 'PER-2SG-0001', decider_authorized: true, status: 'active', revision: 'v1',
    source_reference: 'document-test', source_version: 'v1',
    source_sha256: createHash('sha256').update(bytes).digest('hex') };
  const document = { tenant_id: '2sg', reference: 'document-test', version: 'v1', status: 'available', bytes };
  const input = { environment: 'fictitious', tenantId: '2sg', planId: 'plan-test', decisionId: 'decision-test',
    authority: { read: async () => [decision] }, documents: { readVersion: async () => [document] } };
  return { input, decision, document };
}

test('consistent fictional source is review-only and never executable', async () => {
  const { input } = fixture();
  const result = await reviewFictionalDecisionSource(input);
  assert.equal(result.status, 'fictional_source_consistent_for_review');
  assert.equal(result.executable, false);
  assert.equal(result.productionChanged, false);
  assert.equal(result.humanReviewRequired, true);
});

test('refuses absent, duplicate, unavailable, or altered decision and source', async () => {
  const cases = [
    f => { f.input.authority.read = async () => []; },
    f => { f.input.authority.read = async () => [f.decision, f.decision]; },
    f => { f.input.documents.readVersion = async () => []; },
    f => { f.input.documents.readVersion = async () => [f.document, f.document]; },
    f => { f.decision.status = 'revoked'; },
    f => { f.decision.decider_authorized = false; },
    f => { f.decision.portfolio_function_id = 'finance'; },
    f => { f.decision.operational_plan_id = 'other'; },
    f => { f.document.version = 'v2'; },
    f => { f.document.bytes = Buffer.from('altered'); },
    f => { f.document.tenant_id = 'other'; },
    f => { f.input.documents.readVersion = async () => { throw Error('offline'); }; },
    f => { f.input.environment = 'production'; }
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    const result = await reviewFictionalDecisionSource(f.input);
    assert.equal(result.status, 'unavailable'); assert.equal(result.executable, false);
  }
});

test('refuses a changed decision on reread', async () => {
  const f = fixture(); let reads = 0;
  f.input.authority.read = async () => ++reads === 1 ? [f.decision] : [{ ...f.decision, status: 'revoked' }];
  const result = await reviewFictionalDecisionSource(f.input);
  assert.equal(result.status, 'unavailable'); assert.equal(result.executable, false);
});

function gedFixture() {
  const bytes = Buffer.from('%PDF-1.4\nfictional document only');
  const id = createHash('sha256').update(bytes).digest('hex');
  const policy = { owner: { userId: 'fictional-user', organizationId: 'fictional-tenant' },
    documents: [{ name: 'fictional.pdf', category: 'finance', sha256: id, size: bytes.length }] };
  const principal = { authProvider: 'google', id: 'fictional-user', tenantId: 'fictional-tenant' };
  const scope = scopeFor(policy, principal);
  const event = { revision: 0, current_document_id: id, trashed: false };
  const row = { tenant: scope.tenant, owner_id: scope.owner, document_id: id, byte_size: bytes.length, generation: '123' };
  const input = { policy, principal, rootId: id, versionId: id, revision: 0,
    register: { lifecycle: { history: async () => [event] }, read: async () => row },
    storage: { get: async () => bytes } };
  return { input, event, row, bytes };
}

test('GED document inspection verifies bytes and revision without authorizing the decision', async () => {
  const { input } = gedFixture();
  assert.deepEqual(await inspectGedDecisionDocument(input),
    { status: 'document_verified_for_review', decisionAuthorized: false, executable: false });
});

test('GED document inspection fails closed on changed revision, bytes, scope and unavailable services', async () => {
  const changes = [
    f => { f.event.trashed = true; },
    f => { f.event.revision = 1; },
    f => { f.row.owner_id = 'a'.repeat(64); },
    f => { f.input.principal.id = 'another-user'; },
    f => { f.input.storage.get = async () => Buffer.from('%PDF-altered'); },
    f => { f.input.storage.get = async () => { throw Error('unavailable'); }; },
    f => { f.input.policy.documents[0].category = 'personal'; },
    f => { let calls = 0; f.input.register.lifecycle.history = async () => ++calls === 1 ? [f.event] : [{ ...f.event, revision: 1 }]; }
  ];
  for (const change of changes) {
    const f = gedFixture(); change(f);
    assert.deepEqual(await inspectGedDecisionDocument(f.input),
      { status: 'unavailable', decisionAuthorized: false, executable: false });
  }
});

test('server composition requires a matching current authority and the scoped GED document', async () => {
  const f = gedFixture();
  const plan = { id: 'plan-test', tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'finance',
    decision_reference: f.input.rootId, decision_sha256: f.input.versionId, decision_version: '0' };
  const portfolio = { id: plan.portfolio_id, tenant_id: '2sg' };
  const assignment = { tenant_id: '2sg', operational_plan_id: plan.id, function_id: 'finance', actor_user_id: 'actor-test' };
  const decision = { tenant_id: '2sg', plan_id: plan.id, portfolio_id: portfolio.id, function_id: 'finance',
    decider_person_id: 'PER-2SG-0001', status: 'active', reference: plan.decision_reference,
    sha256: plan.decision_sha256, revision: 0, authority_revision: 'rev-1' };
  const authority = { readCurrent: async () => ({ ...decision }) };
  const verify = createFinancialDecisionVerifierCandidate({ ...f.input, authority });
  const binding = { tenantId: '2sg', actorId: 'actor-test', plan, portfolio, assignment };
  assert.equal(await verify(binding), true);
  decision.status = 'revoked';
  assert.equal(await verify(binding), false);
  decision.status = 'active'; f.event.trashed = true;
  assert.equal(await verify(binding), false);
});

test('server composition rejects unavailable or changing authority and mismatched plan identity', async () => {
  const f = gedFixture();
  assert.throws(() => createFinancialDecisionVerifierCandidate({ ...f.input }), /AUTHORITY_UNAVAILABLE/);
  const plan = { id: 'plan-test', tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'finance',
    decision_reference: f.input.rootId, decision_sha256: f.input.versionId, decision_version: '0' };
  const binding = { tenantId: '2sg', actorId: 'actor-test', plan,
    portfolio: { id: plan.portfolio_id, tenant_id: '2sg' },
    assignment: { tenant_id: '2sg', operational_plan_id: plan.id, function_id: 'finance', actor_user_id: 'actor-test' } };
  const decision = { tenant_id: '2sg', plan_id: plan.id, portfolio_id: plan.portfolio_id, function_id: 'finance',
    decider_person_id: 'PER-2SG-0001', status: 'active', reference: plan.decision_reference,
    sha256: plan.decision_sha256, revision: 0, authority_revision: 'rev-1' };
  let reads = 0;
  const authority = { readCurrent: async () => ++reads === 1 ? decision : { ...decision, status: 'revoked' } };
  const verify = createFinancialDecisionVerifierCandidate({ ...f.input, authority });
  assert.equal(await verify(binding), false);
  assert.equal(await verify({ ...binding, actorId: 'different' }), false);
  authority.readCurrent = async () => { throw Error('offline'); };
  assert.equal(await verify(binding), false);
});

test('server composition gates the existing financial reader and fails after authority revocation', async () => {
  const f = gedFixture();
  const base = id => ({ id, tenant_id: '2sg', governance_status: 'approved', status: 'active', registration_reference: 'test-proof' });
  const plan = { ...base('plan-test'), label: 'Finance', portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'finance',
    decision_reference: f.input.rootId, decision_sha256: f.input.versionId, decision_version: '0' };
  const portfolio = base('PORT-2SG-GLOBAL');
  const assignment = { ...base('assignment-test'), operational_plan_id: plan.id, function_id: 'finance',
    module: 'FINANCES', actor_user_id: 'actor-test', assignee_agent_id: 'person-test', team_id: 'team-test' };
  const decision = { tenant_id: '2sg', plan_id: plan.id, portfolio_id: portfolio.id, function_id: 'finance',
    decider_person_id: 'PER-2SG-0001', status: 'active', reference: plan.decision_reference,
    sha256: plan.decision_sha256, revision: 0, authority_revision: 'rev-1' };
  const verifyDecision = createFinancialDecisionVerifierCandidate({ ...f.input, authority: { readCurrent: async () => ({ ...decision }) } });
  const source = { load: async () => ({ plan, portfolio, assignment,
    person: { id: 'person-test', label: 'Test Person', team_id: 'team-test', active: true } }),
    readCorrespondence: async () => ({ id: RAILWAY_SOURCE, tenant_id: '2sg', direction: 'internal',
      confidentiality: 'internal', not_deleted: true, status: 'in_progress' }), verifyDecision };
  const actor = { tenantId: '2sg', actorId: 'actor-test', permissions: [PERMISSIONS.RESOURCES_READ, PERMISSIONS.CORRESPONDENCE_READ] };
  const bound = await createFinancialOperationReferenceReader({ source }).bindForActor(actor);
  assert.ok(bound);
  decision.status = 'revoked';
  assert.equal(await bound.catalogue.get('operational_plan', plan.id, '2sg'), null);
  assert.equal(await createFinancialOperationReferenceReader({ source }).bindForActor(actor), null);
});

test('pinned financial authority reads a single scoped native plan and rejects inactive status', async () => {
  const f = gedFixture();
  const c = buildFinancialStoragePlanCandidate().tables[0];
  const row = { id: 'plan-test', tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'finance',
    governance_status: 'approved', status: 'active', registration_reference: 'reg-test',
    decision_reference: f.input.rootId, decision_sha256: f.input.versionId, decision_version: '0' };
  let rows = [row];
  const bigquery = { dataset: () => ({ table: () => ({ getMetadata: async () => [{ type: 'TABLE',
    schema: { fields: c.fields }, clustering: { fields: c.clustering } }] }) }),
  query: async ({ params }) => { assert.deepEqual(params, { tenant: '2sg', plan: 'plan-test' }); return [rows]; } };
  const policy = { ...f.input.policy, owner: { userId: 'actor-test', organizationId: '2sg' } };
  const principal = { id: 'actor-test', tenantId: '2sg', authProvider: 'google' };
  const authority = createPinnedFinancialAuthorityCandidate({ bigquery, projectId: 'test-project', datasetId: 'test_dataset',
    policy, principal, actorId: 'actor-test', contract: c,
    anchor: { planId: 'plan-test', registration: 'reg-test', sha256: f.input.rootId, revision: 0 } });
  assert.equal((await authority.readCurrent({ tenantId: '2sg', planId: 'plan-test' })).status, 'active');
  row.status = 'inactive';
  assert.equal(await authority.readCurrent({ tenantId: '2sg', planId: 'plan-test' }), null);
  row.status = 'active'; rows = [row, row];
  assert.equal(await authority.readCurrent({ tenantId: '2sg', planId: 'plan-test' }), null);
  assert.equal(await authority.readCurrent({ tenantId: '2sg', planId: 'another-plan' }), null);
});

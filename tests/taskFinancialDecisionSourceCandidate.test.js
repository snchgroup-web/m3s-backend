'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { reviewFictionalDecisionSource, inspectGedDecisionDocument, createFinancialDecisionVerifierCandidate,
  createPinnedFinancialAuthorityCandidate, createInitialFinancialApprovalPinCandidate, createFinancialRegistrationPreflightCandidate,
  createFinancialFenceReaderCandidate } = require('../taskFinancialDecisionSourceCandidate');
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
  assert.ok(result.pending.includes('respect_existing_approval_and_required_controls'));
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

function registrationFixture() {
  const f = gedFixture();
  f.input.principal.tenantId = '2sg';
  f.input.policy.owner.organizationId = '2sg';
  const scope = scopeFor(f.input.policy, f.input.principal);
  f.row.tenant = scope.tenant; f.row.owner_id = scope.owner;
  const fence = { id: 'registry', contract_version: 'm3s.task-execution.v2', revision: 4 };
  const authority = { tenant_id: '2sg', actor_id: f.input.principal.id, plan_id: 'plan-test',
    registration_reference: 'reg-test', portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'finance', status: 'approved',
    reference: f.input.rootId, sha256: f.input.rootId, revision: 0, authority_revision: 'decision-test-v1' };
  const config = { policy: f.input.policy, register: f.input.register, storage: f.input.storage,
    readFence: async () => fence, readAuthority: async () => authority, canRegister: async () => true,
    resolvePerson: async () => ({ status: 'ok', person: { person_id: 'PER-2SG-0001', team: 'TZH', active: true } }),
    anchor: { planId: 'plan-test', registration: 'reg-test', sha256: f.input.rootId, revision: 0 } };
  return { ...f, config, fence, authority };
}

test('registration preflight uses an independent decision and unchanged fence before a plan exists', async () => {
  const f = registrationFixture();
  assert.deepEqual(await createFinancialRegistrationPreflightCandidate(f.config)(f.input.principal),
    { status: 'verified_for_review', executable: false, observed_revision: 4 });
});

test('initial approval pin supports review before a plan exists while preserving identity and GED checks', async () => {
  const f = registrationFixture();
  f.config.readAuthority = createInitialFinancialApprovalPinCandidate({ policy: f.input.policy,
    principal: f.input.principal, anchor: f.config.anchor, approvalReference: 'decision-test-v1' });
  const preflight = createFinancialRegistrationPreflightCandidate(f.config);
  assert.deepEqual(await preflight(f.input.principal),
    { status: 'historical_pin_verified_for_review', executable: false, observed_revision: 4 });
  assert.equal(await f.config.readAuthority({ tenantId: '2sg', planId: 'other', actorId: f.input.principal.id }), null);
  assert.equal(await f.config.readAuthority({ tenantId: '2sg', planId: 'plan-test', actorId: 'other' }), null);
  f.event.trashed = true;
  assert.deepEqual(await preflight(f.input.principal), { status: 'unavailable', executable: false });
});

test('registration review composes the existing services without creating an execution path', async () => {
  const { createFinancialRegistrationReviewCandidate } = require('../taskFinancialReferenceBridgeCandidate');
  const f = registrationFixture();
  let serviceReads = 0;
  const review = createFinancialRegistrationReviewCandidate({
    getGedServices: async principal => {
      serviceReads++;
      assert.equal(principal, f.input.principal);
      return { policy: f.input.policy, register: f.input.register, storage: f.input.storage };
    }, readFence: f.config.readFence, canRegister: f.config.canRegister, resolvePerson: f.config.resolvePerson,
    anchor: f.config.anchor, approvalReference: 'decision-test-v1', remoteReadsCostQualified: true
  });
  f.config.anchor.planId = 'changed-after-construction';
  assert.deepEqual(await review(f.input.principal),
    { status: 'historical_pin_verified_for_review', executable: false, observed_revision: 4 });
  assert.equal(serviceReads, 1);
  f.input.principal.tenantId = 'another-tenant';
  assert.deepEqual(await review(f.input.principal), { status: 'unavailable', executable: false });
  assert.equal(serviceReads, 1);
});

test('registration review refuses all injected reads until their cost is qualified', async () => {
  const { createFinancialRegistrationReviewCandidate } = require('../taskFinancialReferenceBridgeCandidate');
  const f = registrationFixture();
  let calls = 0;
  const tracked = async () => { calls++; throw Error('unexpected remote operation'); };
  for (const flag of [undefined, false, 'true', 1]) {
    const review = createFinancialRegistrationReviewCandidate({ getGedServices: tracked,
      readFence: tracked, canRegister: tracked, resolvePerson: tracked, anchor: f.config.anchor,
      approvalReference: 'decision-test-v1', remoteReadsCostQualified: flag });
    assert.deepEqual(await review(f.input.principal), { status: 'unavailable', executable: false });
  }
  assert.equal(calls, 0);
});

test('registration review accepts a server-supplied current authority and rejects a changed decision', async () => {
  const { createFinancialRegistrationReviewCandidate } = require('../taskFinancialReferenceBridgeCandidate');
  const f = registrationFixture();
  let reads = 0, revokeOnSecond = false;
  const options = { getGedServices: async () => ({ policy: f.input.policy,
    register: f.input.register, storage: f.input.storage }), readFence: f.config.readFence,
    canRegister: f.config.canRegister, resolvePerson: f.config.resolvePerson, anchor: f.config.anchor,
    readCurrentAuthority: async () => { reads++; return { ...f.authority,
      status: revokeOnSecond && reads === 2 ? 'revoked' : f.authority.status }; }, remoteReadsCostQualified: true };
  const review = createFinancialRegistrationReviewCandidate(options);
  assert.deepEqual(await review(f.input.principal),
    { status: 'verified_for_review', executable: false, observed_revision: 4 });
  assert.equal(reads, 2);
  options.readCurrentAuthority = async () => null;
  // The constructed review keeps its trusted dependency; callers cannot swap it.
  reads = 0;
  revokeOnSecond = true;
  assert.deepEqual(await review(f.input.principal), { status: 'unavailable', executable: false });
  assert.equal(reads, 2);
  assert.throws(() => createFinancialRegistrationReviewCandidate({ ...options, readCurrentAuthority: null }),
    /FINANCE_REGISTRATION_REVIEW_CONFIGURATION_INVALID/);
});

test('registration preflight reuses the existing account-to-directory resolver', async () => {
  const { resolveOwnPersonLink } = require('../ownProfile');
  const f = registrationFixture();
  const email = 'fixture@example.test';
  const account = { id: f.input.principal.id, tenantId: '2sg', email, role: 'Manager', active: true };
  const env = { M3S_AUTH_SINGLE_ACCOUNT_LOGIN_EMAIL: email,
    M3S_AUTH_SINGLE_ACCOUNT_SOURCE_EMAIL_SHA256: createHash('sha256').update(email).digest('hex'),
    M3S_AUTH_SINGLE_ACCOUNT_PROFILE_JSON: JSON.stringify({ personId: 'PER-2SG-0001', tenantId: '2sg' }) };
  const directory = { schema_version: 'rh001-directory-v1', classification: 'C2', status: 'validated_documentary',
    approved_by: 'Fixture', approved_on: '2026-09-26', records: [{ person_id: 'PER-2SG-0001',
      display_name: 'Synthetic Person', preferred_name: 'Synthetic', member_type: 'Fondateur', team: 'TZH',
      subgroup: null, position: 'Synthetic function', active: true }] };
  f.config.resolvePerson = principal => resolveOwnPersonLink({ principal, env, getAccounts: () => [account],
    readDirectory: async () => structuredClone(directory) });
  const preflight = createFinancialRegistrationPreflightCandidate(f.config);
  assert.equal((await preflight(f.input.principal)).status, 'verified_for_review');
  directory.records[0].active = false;
  assert.equal((await preflight(f.input.principal)).status, 'unavailable');
});

test('registration preflight fails closed for stale, missing or unauthorized evidence', async () => {
  const changes = [
    f => { f.config.canRegister = async () => false; },
    f => { f.config.canRegister = async () => 'allowed'; },
    f => { let calls = 0; f.config.canRegister = async () => ++calls === 1; },
    f => { f.input.principal.id = 'other'; f.config.canRegister = async () => { f.input.principal.id = 'fictional-user'; return true; }; },
    f => { f.config.resolvePerson = async () => ({ status: 'ok', person: { person_id: 'PER-2SG-0002', active: true } }); },
    f => { f.config.resolvePerson = async () => ({ status: 'ok', person: { person_id: 'PER-2SG-0001', active: false } }); },
    f => { f.config.resolvePerson = async () => ({ status: 'ok', person: { person_id: 'PER-2SG-0001', team: 'other', active: true } }); },
    f => { let calls = 0; f.config.resolvePerson = async () => ++calls === 1 ?
      { status: 'ok', person: { person_id: 'PER-2SG-0001', team: 'TZH', active: true } } : { status: 'unavailable' }; },
    f => { f.authority.status = 'revoked'; },
    f => { f.authority.actor_id = 'other'; },
    f => { f.event.trashed = true; },
    f => { f.config.storage.get = async () => Buffer.from('altered'); },
    f => { f.fence.revision = -5; },
    f => { let reads = 0; f.config.readFence = async () => { if (++reads === 2) f.fence.revision++; return f.fence; }; },
    f => { let reads = 0; f.config.readFence = async () => { if (++reads === 2) f.input.principal.id = 'other'; return f.fence; }; },
    f => { let reads = 0; f.config.readAuthority = async () => ++reads === 1 ? f.authority : { ...f.authority, status: 'revoked' }; },
    f => { f.config.readAuthority = async () => { throw Error('offline'); }; }
  ];
  for (const change of changes) {
    const f = registrationFixture(); change(f);
    assert.deepEqual(await createFinancialRegistrationPreflightCandidate(f.config)(f.input.principal),
      { status: 'unavailable', executable: false });
  }
});

test('fence reader checks the real schema contract and accepts one safe, open revision', async () => {
  const contract = require('../taskRegistry').TASK_TABLE_CONTRACTS.administration_task_registry_state;
  const meta = { type: 'TABLE', schema: { fields: contract.fields }, clustering: { fields: [] } };
  let rows = [{ id: 'registry', contract_version: 'm3s.task-execution.v2', revision: { value: '4' } }];
  let reads = 0;
  const bigquery = { dataset: name => { assert.equal(name, 'test_dataset'); return { table: name => {
    assert.equal(name, 'administration_task_registry_state'); return { getMetadata: async () => [meta] };
  } }; }, query: async options => {
    reads++; assert.match(options.query, /administration_task_registry_state` LIMIT 2/);
    assert.equal(options.maximumBytesBilled, '10485760'); return [rows];
  } };
  const read = createFinancialFenceReaderCandidate({ bigquery, projectId: 'test-project', datasetId: 'test_dataset' });
  assert.equal(reads, 0);
  assert.deepEqual(await read(), { id: 'registry', revision: 4, contract_version: 'm3s.task-execution.v2' });
  rows = [rows[0], rows[0]]; assert.equal(await read(), null);
  rows = [{ id: 'registry', contract_version: 'm3s.task-execution.v2', revision: '-5' }]; assert.equal(await read(), null);
  rows = [{ id: 'registry', contract_version: 'm3s.task-execution.v2', revision: '9007199254740992' }]; assert.equal(await read(), null);
  meta.expirationTime = '1'; assert.equal(await read(), null);
  delete meta.expirationTime; meta.schema = { fields: [] }; assert.equal(await read(), null);
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
  rows = [];
  assert.equal(await authority.readCurrent({ tenantId: '2sg', planId: 'plan-test' }), null);
  rows = [row];
  assert.equal((await authority.readCurrent({ tenantId: '2sg', planId: 'plan-test' })).status, 'active');
  row.status = 'inactive';
  assert.equal(await authority.readCurrent({ tenantId: '2sg', planId: 'plan-test' }), null);
  row.status = 'active'; rows = [row, row];
  assert.equal(await authority.readCurrent({ tenantId: '2sg', planId: 'plan-test' }), null);
  assert.equal(await authority.readCurrent({ tenantId: '2sg', planId: 'another-plan' }), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTaskExecutionContext: normalize,
  normalizeTaskSourceLinks,
  resolveTaskExecutionContext: resolve
} = require('../taskExecutionContract');

const project = () => ({ execution_kind: 'project', phase_id: 'phase-test' });
const operation = () => ({ execution_kind: 'operation', operational_plan_id: 'plan-test' });
const recurring = () => ({ ...operation(), recurrence_id: 'recurrence-test', occurrence_key: '2026-11' });
function fixture(change = () => {}) {
  const record = (id, fields = {}) => ({ id, tenant_id: 'tenant-test',
    governance_status: 'approved', status: 'active', ...fields });
  const records = {
    phase: record('phase-test', { project_id: 'project-test' }),
    project: record('project-test', { dossier_id: 'dossier-test' }),
    dossier: record('dossier-test', { portfolio_id: 'portfolio-test' }),
    portfolio: record('portfolio-test'),
    activity: record('activity-test', { phase_id: 'phase-test' }),
    operational_plan: record('plan-test', { portfolio_id: 'portfolio-test', function_id: 'function-test' }),
    recurrence: record('recurrence-test', { operational_plan_id: 'plan-test',
      cadence_validated: true, cadence_reference: 'synthetic-authorisation' })
  };
  change(records);
  const calls = [];
  const catalogue = {
    async get(kind, id, tenant) {
      calls.push({ kind, id, tenant });
      return records[kind]?.id === id ? records[kind] : null;
    },
    async resolveOccurrenceKey(_recurrence, key) {
      return ['2026-11', '2026-12'].includes(key) ? key : null;
    }
  };
  return { records, calls, catalogue, tenantId: 'tenant-test' };
}

test('project context has a required phase and no empty intermediate activity', () => {
  assert.deepEqual(normalize(project()), { execution_kind: 'project', phase_id: 'phase-test',
    activity_id: null, operational_plan_id: null, recurrence_id: null, occurrence_key: null });
});
test('a one-off operation needs only its governed plan, not a fictional recurrence', () => {
  const value = normalize(operation());
  assert.equal(value.operational_plan_id, 'plan-test');
  assert.equal(value.phase_id, null);
  assert.equal(value.recurrence_id, null);
});
for (const [name, value] of [
  ['missing project phase', { execution_kind: 'project' }],
  ['missing operation plan', { execution_kind: 'operation' }],
  ['both branches', { ...project(), operational_plan_id: 'plan-test' }],
  ['operation with a phase', { ...operation(), phase_id: 'phase-test' }],
  ['operation with a project activity', { ...operation(), activity_id: 'activity-test' }],
  ['project with recurrence', { ...project(), recurrence_id: 'recurrence-test', occurrence_key: '2026-11' }],
  ['recurrence without occurrence', { ...operation(), recurrence_id: 'recurrence-test' }],
  ['occurrence without model', { ...operation(), occurrence_key: '2026-11' }],
  ['forged project parent', { ...project(), project_id: 'another-project' }],
  ['forged tenant', { ...project(), tenant_id: 'another-tenant' }],
  ['forged proof', { ...project(), governance_status: 'approved' }],
  ['unknown branch', { execution_kind: 'historical', phase_id: 'phase-test' }],
  ['empty ID', { ...project(), phase_id: '' }],
  ['multiple parents', { ...project(), phase_id: ['phase-test', 'other'] }],
  ['multiline ID', { ...project(), phase_id: 'phase-test\nother' }],
  ['non-object context', null]
]) {
  test(`context rejects ${name}`, () => assert.throws(() => normalize(value), { code: 'TASK_CONTEXT_INVALID' }));
}

test('project ancestry is derived only from the governed phase and same-phase activity', async () => {
  const f = fixture();
  const context = await resolve({ ...project(), activity_id: 'activity-test' }, f);
  assert.equal(context.project_id, 'project-test');
  assert.equal(context.dossier_id, 'dossier-test');
  assert.equal(context.portfolio_id, 'portfolio-test');
  assert.equal(context.operational_plan_id, null);
  assert.equal(f.calls.length, 5);
});
test('activity in another phase is rejected', async () => {
  const f = fixture(r => { r.activity.phase_id = 'other-phase'; });
  await assert.rejects(resolve({ ...project(), activity_id: 'activity-test' }, f),
    { code: 'TASK_CONTEXT_REFERENCE_UNQUALIFIED' });
});
for (const kind of ['phase', 'project', 'dossier', 'portfolio']) {
  test(`a foreign-tenant ${kind} cannot qualify project ancestry`, async () => {
    const f = fixture(r => { r[kind].tenant_id = 'other-tenant'; });
    await assert.rejects(resolve(project(), f), { code: 'TASK_CONTEXT_REFERENCE_UNQUALIFIED' });
  });
}
for (const patch of [{ governance_status: 'candidate' }, { status: 'inactive' }, { id: 'other-phase' }]) {
  test(`unqualified phase rejected: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(r => Object.assign(r.phase, patch));
    await assert.rejects(resolve(project(), f), { code: 'TASK_CONTEXT_REFERENCE_UNQUALIFIED' });
  });
}
test('missing catalogue fails closed without inferring a source', async () => {
  await assert.rejects(resolve(project(), { tenantId: 'tenant-test' }), { code: 'TASK_CONTEXT_SOURCE_UNAVAILABLE' });
});
test('catalogue error is sanitized', async () => {
  const f = fixture();
  f.catalogue.get = async () => { throw Error('private SQL or credential'); };
  await assert.rejects(resolve(project(), f), error =>
    error.code === 'TASK_CONTEXT_SOURCE_UNAVAILABLE' && !error.message.includes('private'));
});
test('operation derives function and portfolio without creating a project or phase', async () => {
  const context = await resolve(operation(), fixture());
  assert.equal(context.function_id, 'function-test');
  assert.equal(context.portfolio_id, 'portfolio-test');
  assert.equal(context.project_id, null);
  assert.equal(context.phase_id, null);
  assert.equal(context.occurrence_identity, null);
});
test('optional operation dossier must belong to its portfolio', async () => {
  const f = fixture(r => { r.operational_plan.dossier_id = 'dossier-test'; r.dossier.portfolio_id = 'different'; });
  await assert.rejects(resolve(operation(), f), { code: 'TASK_CONTEXT_REFERENCE_UNQUALIFIED' });
});
for (const patch of [
  { operational_plan_id: 'other-plan' }, { cadence_validated: false },
  { cadence_reference: '' }, { tenant_id: 'other-tenant' }
]) {
  test(`recurrence rejects unqualified model: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(r => Object.assign(r.recurrence, patch));
    await assert.rejects(resolve(recurring(), f), { code: 'TASK_CONTEXT_REFERENCE_UNQUALIFIED' });
  });
}
test('recurrence requires a source-qualified occurrence key, not just a calendar-looking value', async () => {
  const f = fixture();
  await assert.rejects(resolve({ ...recurring(), occurrence_key: '2027-01' }, f),
    { code: 'TASK_CONTEXT_REFERENCE_UNQUALIFIED' });
  delete f.catalogue.resolveOccurrenceKey;
  await assert.rejects(resolve(recurring(), f), { code: 'TASK_CONTEXT_SOURCE_UNAVAILABLE' });
});
test('occurrence identity is stable across retries and actors but distinct between periods', async () => {
  const f = fixture();
  const first = await resolve(recurring(), { ...f, actorId: 'actor-one' });
  const replay = await resolve(recurring(), { ...f, actorId: 'actor-two' });
  const next = await resolve({ ...recurring(), occurrence_key: '2026-12' }, f);
  assert.match(first.occurrence_identity, /^[a-f0-9]{64}$/);
  assert.equal(first.occurrence_identity, replay.occurrence_identity);
  assert.notEqual(first.occurrence_identity, next.occurrence_identity);
});
test('normalization and resolution never mutate input or catalogue records', async () => {
  const input = recurring();
  const f = fixture();
  const before = JSON.stringify({ input, records: f.records });
  await resolve(input, f);
  assert.equal(JSON.stringify({ input, records: f.records }), before);
});
test('occurrence identities are distinct across tenants and recurrence models', async () => {
  const first = await resolve(recurring(), fixture());
  const otherTenant = fixture(r => Object.values(r).forEach(record => { record.tenant_id = 'tenant-other'; }));
  const second = await resolve(recurring(), { ...otherTenant, tenantId: 'tenant-other' });
  const otherModel = fixture(r => { r.recurrence.id = 'recurrence-other'; });
  const third = await resolve({ ...recurring(), recurrence_id: 'recurrence-other' }, otherModel);
  assert.notEqual(first.occurrence_identity, second.occurrence_identity);
  assert.notEqual(first.occurrence_identity, third.occurrence_identity);
});
test('a foreign-tenant operation plan is rejected', async () => {
  const f = fixture(r => { r.operational_plan.tenant_id = 'tenant-other'; });
  await assert.rejects(resolve(operation(), f), { code: 'TASK_CONTEXT_REFERENCE_UNQUALIFIED' });
});
test('a recurring operation never guesses its function or its cadence from an empty field', async () => {
  const f = fixture(r => { r.operational_plan.function_id = null; });
  await assert.rejects(resolve(recurring(), f), { code: 'TASK_CONTEXT_INVALID' });
});
test('source links are typed, stable and order-independent without fetching any file', () => {
  const links = [{ kind: 'ged', reference: 'GED-test' }, { kind: 'correspondence', reference: 'COR-test' }];
  const before = JSON.stringify(links);
  assert.deepEqual(normalizeTaskSourceLinks(links), normalizeTaskSourceLinks([...links].reverse()));
  assert.equal(JSON.stringify(links), before);
});
test('Agenda must reuse its correspondence source, not a second link kind', () => {
  assert.throws(() => normalizeTaskSourceLinks([{ kind: 'agenda', reference: 'COR-test' }]),
    { code: 'TASK_SOURCE_LINK_INVALID' });
  assert.throws(() => normalizeTaskSourceLinks([
    { kind: 'correspondence', reference: 'COR-test' },
    { kind: 'correspondence', reference: ' COR-test ' }
  ]), { code: 'TASK_SOURCE_LINK_DUPLICATE' });
});
test('invalid source fields, missing values and oversized lists are refused', () => {
  for (const input of [null, [{ kind: 'ged', reference: '' }],
    [{ kind: 'ged', reference: 'test', approved: true }],
    [{ kind: 'journal', reference: 'line\nnext' }],
    Array.from({ length: 33 }, (_, i) => ({ kind: 'ged', reference: `test-${i}` }))]) {
    assert.throws(() => normalizeTaskSourceLinks(input), { code: 'TASK_SOURCE_LINK_INVALID' });
  }
});

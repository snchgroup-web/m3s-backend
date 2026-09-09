const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BudgetReferenceError,
  MAX_DETAIL_REFERENCE_PAIRS,
  MAX_LIST_REFERENCE_RESOLUTIONS,
  OPERATIONS,
  createBudgetReferenceService
} = require('../financeBudgetV2References');
const { createFakeBudgetReferenceResolver } = require('./helpers/fakeBudgetReferenceResolver');

const AT = new Date('2026-09-09T10:00:00.000Z');
const TENANT = 'tenant-2sg';
const ACTOR = 'user-cheikh';

function periods() {
  return [
    ['P01', '2026-01-01', '2026-01-31'], ['P02', '2026-02-01', '2026-02-28'],
    ['P03', '2026-03-01', '2026-03-31'], ['P04', '2026-04-01', '2026-04-30'],
    ['P05', '2026-05-01', '2026-05-31'], ['P06', '2026-06-01', '2026-06-30'],
    ['P07', '2026-07-01', '2026-07-31'], ['P08', '2026-08-01', '2026-08-31'],
    ['P09', '2026-09-01', '2026-09-30'], ['P10', '2026-10-01', '2026-10-31'],
    ['P11', '2026-11-01', '2026-11-30'], ['P12', '2026-12-01', '2026-12-31']
  ].map(([periodId, startDate, endDate], index) => ({
    periodId, ordinal: index + 1, startDate, endDate
  }));
}

function base(id, overrides = {}) {
  return {
    id,
    tenantId: TENANT,
    status: 'active',
    effectiveFrom: '2025-01-01T00:00:00Z',
    effectiveTo: null,
    labelSnapshot: `Reference ${id}`,
    sourceRevision: 'rev-1',
    confidentiality: 'internal',
    visible: true,
    ...overrides
  };
}

function fixtures() {
  return {
    entity: [base('ORG-2SG')],
    fiscalYear: [base('FY-2026', {
      status: 'open', entityId: 'ORG-2SG', summaryYear: '2026',
      startDate: '2026-01-01', endDate: '2026-12-31', periodicity: 'monthly',
      timezone: 'Europe/Zurich', periods: periods()
    })],
    function: [base('finance')],
    team: [base('TZH')],
    agent: [
      base('cheikh', { teamId: 'TZH', allowedResponsibilities: ['budgetOwnerAgentId'] }),
      base('chantal', { teamId: 'TZH', allowedResponsibilities: ['controllerAgentId'] })
    ],
    country: [base('CH')],
    portfolio: [base('PORT-1', { functionId: 'finance' })],
    dossier: [base('DOS-1', { portfolioId: 'PORT-1' })],
    project: [base('PROJ-1', { status: 'active', dossierId: 'DOS-1' })],
    phase: [base('PHASE-1', { status: 'open', projectId: 'PROJ-1' })]
  };
}

function budget() {
  return {
    title: 'Budget 2SG 2026',
    identity: { entityId: 'ORG-2SG', fiscalYearId: 'FY-2026' },
    responsibilities: { budgetOwnerAgentId: 'cheikh', controllerAgentId: 'chantal' },
    rate: '', rateSource: '', rateDate: '',
    rows: [{
      id: 'row-1', label: 'Fonctionnement', kind: 'operating', direction: 'out',
      currency: 'CHF',
      periodValues: periods().map(period => ({ periodId: period.periodId, value: '' })),
      dimensions: {
        functionId: 'finance', teamId: 'TZH', agentId: 'cheikh', countryId: 'CH',
        portfolioId: 'PORT-1', dossierId: 'DOS-1', projectId: 'PROJ-1', phaseId: 'PHASE-1'
      }
    }]
  };
}

function setup(data = fixtures()) {
  const resolvers = Object.fromEntries(Object.entries(data).map(([type, records]) => [
    type, createFakeBudgetReferenceResolver(records)
  ]));
  return { resolvers, service: createBudgetReferenceService({ resolvers }) };
}

async function rejects(run, code) {
  await assert.rejects(run, error => error && error.code === code);
}

function storedCall(service, rawBudget = budget(), overrides = {}) {
  return service.resolveStoredBudgetReferences({
    rawBudget,
    tenantId: TENANT,
    actorId: ACTOR,
    operation: OPERATIONS.READ,
    resolvedAt: new Date(AT),
    ...overrides
  });
}

test('stored resolution is pure, read-only and creates snapshots after validation', async () => {
  const { service, resolvers } = setup();
  const source = budget();
  const before = structuredClone(source);

  const result = await storedCall(service, source);

  assert.deepEqual(source, before);
  assert.equal(result.identity.entityId.id, 'ORG-2SG');
  assert.equal(result.identity.entityId.resolvedAt, AT.toISOString());
  assert.equal(result.rows[0].dimensions.projectId.id, 'PROJ-1');
  assert.equal(resolvers.entity.calls[0].operation, OPERATIONS.READ);
  assert.equal(resolvers.entity.calls[0].resolvedAt, AT.toISOString());
  assert.equal(Object.hasOwn(result.identity.entityId, 'tenantId'), false);
});

test('stored resolution requires explicit READ and a frozen request instant', async () => {
  const { service, resolvers } = setup();
  await rejects(() => storedCall(service, budget(), { operation: undefined }), 'BUDGET_REQUEST_INVALID');
  await rejects(() => storedCall(service, budget(), { operation: OPERATIONS.WRITE }), 'BUDGET_REQUEST_INVALID');
  await rejects(() => storedCall(service, budget(), { resolvedAt: new Date('invalid') }), 'BUDGET_REQUEST_INVALID');
  assert.equal(resolvers.entity.calls.length, 0);
});

test('one stored service is bound to one actor, tenant and instant', async () => {
  const { service, resolvers } = setup();
  await storedCall(service);
  const calls = Object.values(resolvers).reduce((sum, resolver) => sum + resolver.calls.length, 0);

  await rejects(() => storedCall(service, budget(), { actorId: 'user-other' }), 'BUDGET_REQUEST_INVALID');
  await rejects(() => storedCall(service, budget(), {
    resolvedAt: new Date('2026-09-09T10:00:01.000Z')
  }), 'BUDGET_REQUEST_INVALID');
  assert.equal(Object.values(resolvers).reduce(
    (sum, resolver) => sum + resolver.calls.length, 0
  ), calls);
});

test('shared cache resolves each type and id pair only once across stored drafts', async () => {
  const { service, resolvers } = setup();
  await storedCall(service);
  const calls = Object.fromEntries(Object.entries(resolvers).map(([type, resolver]) => [
    type, resolver.calls.length
  ]));

  await storedCall(service, structuredClone(budget()));

  for (const [type, resolver] of Object.entries(resolvers)) {
    assert.equal(resolver.calls.length, calls[type]);
  }
});

test('mutating one returned snapshot cannot contaminate the shared cache', async () => {
  const { service, resolvers } = setup();
  const first = await storedCall(service);
  first.identity.entityId.labelSnapshot = 'Tampered';
  first.identity.fiscalYearId.periods[0].periodId = 'Tampered';

  const second = await storedCall(service);

  assert.equal(second.identity.entityId.labelSnapshot, 'Reference ORG-2SG');
  assert.equal(second.identity.fiscalYearId.periods[0].periodId, 'P01');
  assert.equal(resolvers.entity.calls.length, 1);
  assert.equal(resolvers.fiscalYear.calls.length, 1);
});

test('reference refusal precedes an independent stored budget corruption', async () => {
  const data = fixtures();
  data.entity = [];
  const { service } = setup(data);
  const source = budget();
  source.title = '';

  await rejects(() => storedCall(service, source), 'BUDGET_REFERENCE_NOT_FOUND');
});

test('complete T1-A validation still rejects corruption after references pass', async () => {
  const { service } = setup();
  const source = budget();
  source.title = '';

  await rejects(() => storedCall(service, source), 'BUDGET_REQUEST_INVALID');
});

test('an unextractable reference path fails before every source call', async () => {
  const { service, resolvers } = setup();
  const source = budget();
  delete source.rows[0].dimensions.projectId;

  await rejects(() => storedCall(service, source), 'BUDGET_STORAGE_UNAVAILABLE');
  assert.equal(Object.values(resolvers).reduce(
    (sum, resolver) => sum + resolver.calls.length, 0
  ), 0);
});

test('fiscal, responsibility and relation failures keep their specialised codes', async () => {
  const fiscal = fixtures();
  fiscal.fiscalYear[0].periods = fiscal.fiscalYear[0].periods.slice(0, 11);
  await rejects(() => storedCall(setup(fiscal).service), 'BUDGET_FISCAL_YEAR_INVALID');

  const responsibility = fixtures();
  responsibility.agent[0].allowedResponsibilities = [];
  await rejects(() => storedCall(setup(responsibility).service), 'BUDGET_RESPONSIBILITY_INVALID');

  const relation = fixtures();
  relation.project[0].dossierId = 'DOS-OTHER';
  await rejects(() => storedCall(setup(relation).service), 'BUDGET_REFERENCE_RELATION_INVALID');
});

test('path-dependent responsibility checks are repeated for cached records', async () => {
  const data = fixtures();
  data.agent = [base('cheikh', {
    teamId: 'TZH', allowedResponsibilities: ['budgetOwnerAgentId']
  })];
  const source = budget();
  source.responsibilities.controllerAgentId = 'cheikh';
  const { service, resolvers } = setup(data);

  await rejects(() => storedCall(service, source), 'BUDGET_RESPONSIBILITY_INVALID');
  assert.equal(resolvers.agent.calls.length, 1);
});

function largeBudget(batch, rowCount = 100) {
  const source = {
    title: `Budget ${batch}`,
    identity: { entityId: `entity-${batch}`, fiscalYearId: `fiscal-${batch}` },
    responsibilities: {
      budgetOwnerAgentId: `owner-${batch}`,
      controllerAgentId: `controller-${batch}`
    },
    rate: '', rateSource: '', rateDate: '', rows: []
  };
  for (let index = 0; index < rowCount; index += 1) {
    source.rows.push({
      id: `row-${batch}-${index}`,
      label: `Ligne ${index}`,
      kind: 'operating',
      direction: 'out',
      currency: 'CHF',
      periodValues: periods().map(period => ({ periodId: period.periodId, value: '' })),
      dimensions: Object.fromEntries(Object.entries({
        functionId: 'function', teamId: 'team', agentId: 'agent', countryId: 'country',
        portfolioId: 'portfolio', dossierId: 'dossier', projectId: 'project', phaseId: 'phase'
      }).map(([key, type]) => [key, `${type}-${batch}-${index}`]))
    });
  }
  return source;
}

function dynamicService() {
  const calls = [];
  const resolvers = Object.fromEntries([
    'entity', 'fiscalYear', 'function', 'team', 'agent', 'country',
    'portfolio', 'dossier', 'project', 'phase'
  ].map(type => [type, async query => {
    calls.push({ type, ...query });
    const match = query.id.match(/^(?:owner|controller|[a-z]+)-([^-]+)(?:-(\d+))?$/);
    const batch = match ? match[1] : 'unknown';
    const index = match && match[2] !== undefined ? Number(match[2]) : 0;
    const overrides = {};
    if (type === 'fiscalYear') Object.assign(overrides, {
      status: 'open', entityId: `entity-${batch}`, summaryYear: '2026',
      startDate: '2026-01-01', endDate: '2026-12-31', periodicity: 'monthly',
      timezone: 'Europe/Zurich', periods: periods()
    });
    if (type === 'agent') Object.assign(overrides, {
      teamId: `team-${batch}-${index}`,
      allowedResponsibilities: query.id.startsWith('owner-')
        ? ['budgetOwnerAgentId']
        : query.id.startsWith('controller-') ? ['controllerAgentId'] : []
    });
    if (type === 'portfolio') overrides.functionId = `function-${batch}-${index}`;
    if (type === 'dossier') overrides.portfolioId = `portfolio-${batch}-${index}`;
    if (type === 'project') overrides.dossierId = `dossier-${batch}-${index}`;
    if (type === 'phase') overrides.projectId = `project-${batch}-${index}`;
    return { available: true, records: [base(query.id, overrides)] };
  }]));
  return { calls, service: createBudgetReferenceService({ resolvers }) };
}

test('the 805th distinct pair in one draft is refused before source access', async () => {
  assert.equal(MAX_DETAIL_REFERENCE_PAIRS, 804);
  const { service, calls } = dynamicService();

  await rejects(() => storedCall(service, largeBudget('overflow', 101)),
    'BUDGET_STORAGE_UNAVAILABLE');
  assert.equal(calls.length, 0);
});

test('the shared cache refuses the 4097th distinct pair before its source call', async () => {
  assert.equal(MAX_LIST_REFERENCE_RESOLUTIONS, 4096);
  const { service, calls } = dynamicService();

  for (let batch = 0; batch < 5; batch += 1) {
    await storedCall(service, largeBudget(`b${batch}`));
  }
  await rejects(() => storedCall(service, largeBudget('b5')),
    'BUDGET_STORAGE_UNAVAILABLE');
  assert.equal(calls.length, MAX_LIST_REFERENCE_RESOLUTIONS);
});

test('stored reference errors never expose raw resolver records', async () => {
  const data = fixtures();
  data.entity = [base('ORG-2SG'), base('ORG-2SG', { sourceRevision: 'rev-2' })];
  const { service } = setup(data);

  await assert.rejects(() => storedCall(service), error => {
    assert.ok(error instanceof BudgetReferenceError);
    assert.equal(error.code, 'BUDGET_REFERENCE_UNAVAILABLE');
    assert.equal(Object.hasOwn(error, 'records'), false);
    return true;
  });
});

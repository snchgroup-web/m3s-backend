const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BudgetReferenceError,
  OPERATIONS,
  createBudgetReferenceService
} = require('../financeBudgetV2References');
const { createFakeBudgetReferenceResolver } = require('./helpers/fakeBudgetReferenceResolver');

const NOW = new Date('2026-09-09T10:00:00.000Z');
const TENANT = 'tenant-2sg';
const ACTOR = 'user-cheikh';

const periods = () => [
  ['P01', '2026-01-01', '2026-01-31'], ['P02', '2026-02-01', '2026-02-28'],
  ['P03', '2026-03-01', '2026-03-31'], ['P04', '2026-04-01', '2026-04-30'],
  ['P05', '2026-05-01', '2026-05-31'], ['P06', '2026-06-01', '2026-06-30'],
  ['P07', '2026-07-01', '2026-07-31'], ['P08', '2026-08-01', '2026-08-31'],
  ['P09', '2026-09-01', '2026-09-30'], ['P10', '2026-10-01', '2026-10-31'],
  ['P11', '2026-11-01', '2026-11-30'], ['P12', '2026-12-01', '2026-12-31']
].map(([periodId, startDate, endDate], index) => ({
  periodId, ordinal: index + 1, startDate, endDate
}));

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
      id: 'row-1', label: 'Fonctionnement', kind: 'operating', direction: 'out', currency: 'CHF',
      periodValues: periods().map(period => ({ periodId: period.periodId, value: '' })),
      dimensions: {
        functionId: 'finance', teamId: 'TZH', agentId: 'cheikh', countryId: 'CH',
        portfolioId: 'PORT-1', dossierId: 'DOS-1', projectId: 'PROJ-1', phaseId: 'PHASE-1'
      }
    }]
  };
}

function setup(data = fixtures(), options = {}) {
  const resolvers = Object.fromEntries(Object.entries(data).map(([type, records]) => [
    type,
    createFakeBudgetReferenceResolver(records, options[type])
  ]));
  return {
    resolvers,
    service: createBudgetReferenceService({
      resolvers,
      clock: () => new Date(NOW),
      canAccessRestricted: options.canAccessRestricted
    })
  };
}

async function rejects(run, code) {
  await assert.rejects(run, error => error instanceof BudgetReferenceError && error.code === code);
}

test('resolves every V2 reference into a closed snapshot with one request timestamp', async () => {
  const { service, resolvers } = setup();
  const source = budget();
  const before = structuredClone(source);
  const result = await service.resolveBudgetReferences({
    budget: source, tenantId: TENANT, actorId: ACTOR
  });

  assert.deepEqual(source, before);
  assert.equal(result.identity.entityId.id, 'ORG-2SG');
  assert.equal(result.identity.fiscalYearId.periods.length, 12);
  assert.equal(result.identity.fiscalYearId.resolvedAt, NOW.toISOString());
  assert.equal(result.responsibilities.budgetOwnerAgentId.teamId, 'TZH');
  assert.equal(result.rows[0].rowId, 'row-1');
  assert.equal(result.rows[0].dimensions.portfolioId.functionId, 'finance');
  assert.deepEqual(Object.keys(result.rows[0].dimensions), [
    'functionId', 'teamId', 'agentId', 'countryId',
    'portfolioId', 'dossierId', 'projectId', 'phaseId'
  ]);
  assert.equal(resolvers.entity.calls[0].tenantId, TENANT);
  assert.equal(resolvers.entity.calls[0].actorId, ACTOR);
  assert.equal(resolvers.agent.calls.length, 2);
});

test('explicit null dimensions stay null and do not require unused resolver interfaces', async () => {
  const source = budget();
  for (const key of Object.keys(source.rows[0].dimensions)) source.rows[0].dimensions[key] = null;
  const data = fixtures();
  const resolvers = {
    entity: createFakeBudgetReferenceResolver(data.entity),
    fiscalYear: createFakeBudgetReferenceResolver(data.fiscalYear),
    agent: createFakeBudgetReferenceResolver(data.agent)
  };
  const service = createBudgetReferenceService({ resolvers, clock: () => new Date(NOW) });
  const result = await service.resolveBudgetReferences({
    budget: source, tenantId: TENANT, actorId: ACTOR
  });
  assert.deepEqual(result.rows[0].dimensions, {
    functionId: null, teamId: null, agentId: null, countryId: null,
    portfolioId: null, dossierId: null, projectId: null, phaseId: null
  });
});

test('wrong-tenant, hidden and absent references share the non-disclosing not-found code', async () => {
  for (const mutate of [
    data => { data.entity[0].tenantId = 'another-tenant'; },
    data => { data.entity[0].visible = false; },
    data => { data.entity = []; }
  ]) {
    const data = fixtures();
    mutate(data);
    await rejects(() => setup(data).service.resolveBudgetReferences({
      budget: budget(), tenantId: TENANT, actorId: ACTOR
    }), 'BUDGET_REFERENCE_NOT_FOUND');
  }
});

test('duplicate resolver matches make the source unverifiable', async () => {
  const data = fixtures();
  data.entity.push({ ...data.entity[0] });
  await rejects(() => setup(data).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_UNAVAILABLE');
});

test('restricted references stay hidden by default and require an explicit policy grant', async () => {
  const data = fixtures();
  data.portfolio[0].confidentiality = 'restricted';
  await rejects(() => setup(data).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_NOT_FOUND');

  const granted = setup(data, {
    canAccessRestricted: ({ type, actorId }) => type === 'portfolio' && actorId === ACTOR
  });
  const result = await granted.service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  });
  assert.equal(result.rows[0].dimensions.portfolioId.id, 'PORT-1');
});

test('source failure, unavailable result and missing source revision fail closed as unavailable', async () => {
  await rejects(() => setup(fixtures(), { entity: { available: false } })
    .service.resolveBudgetReferences({ budget: budget(), tenantId: TENANT, actorId: ACTOR }),
  'BUDGET_REFERENCE_UNAVAILABLE');
  await rejects(() => setup(fixtures(), { entity: { throwError: true } })
    .service.resolveBudgetReferences({ budget: budget(), tenantId: TENANT, actorId: ACTOR }),
  'BUDGET_REFERENCE_UNAVAILABLE');
  const data = fixtures();
  data.entity[0].sourceRevision = '';
  await rejects(() => setup(data).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_UNAVAILABLE');
});

test('source availability and visibility take precedence over lifecycle regardless of field order', async () => {
  const unavailable = fixtures();
  unavailable.entity[0].effectiveFrom = '2027-01-01T00:00:00Z';
  await rejects(() => setup(unavailable, { portfolio: { available: false } })
    .service.resolveBudgetReferences({ budget: budget(), tenantId: TENANT, actorId: ACTOR }),
  'BUDGET_REFERENCE_UNAVAILABLE');

  const hidden = fixtures();
  hidden.entity[0].effectiveFrom = '2027-01-01T00:00:00Z';
  hidden.portfolio[0].visible = false;
  await rejects(() => setup(hidden).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_NOT_FOUND');
});

test('all lifecycle checks precede fiscal, responsibility and relation validation', async () => {
  const beforeFiscal = fixtures();
  beforeFiscal.fiscalYear[0].periods = null;
  beforeFiscal.function[0].status = 'inactive';
  await rejects(() => setup(beforeFiscal).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_STATE_INVALID');

  const beforeRelation = fixtures();
  beforeRelation.fiscalYear[0].entityId = 'ORG-OTHER';
  beforeRelation.agent[0].allowedResponsibilities = ['controllerAgentId'];
  await rejects(() => setup(beforeRelation).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_RESPONSIBILITY_INVALID');

  const fiscalBeforeResponsibility = fixtures();
  fiscalBeforeResponsibility.agent[0].allowedResponsibilities = ['controllerAgentId'];
  const wrongPeriods = budget();
  wrongPeriods.rows[0].periodValues[11].periodId = 'OTHER-P12';
  await rejects(() => setup(fiscalBeforeResponsibility).service.resolveBudgetReferences({
    budget: wrongPeriods, tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_FISCAL_YEAR_INVALID');

  const generalBeforeResponsibility = fixtures();
  generalBeforeResponsibility.agent[0].status = 'inactive';
  generalBeforeResponsibility.function[0].status = 'inactive';
  await rejects(() => setup(generalBeforeResponsibility).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_STATE_INVALID');

  const generalBeforeFiscalLifecycle = fixtures();
  generalBeforeFiscalLifecycle.fiscalYear[0].effectiveFrom = '2027-01-01T00:00:00Z';
  generalBeforeFiscalLifecycle.function[0].status = 'inactive';
  await rejects(() => setup(generalBeforeFiscalLifecycle).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_STATE_INVALID');
});

test('future, expired and inactive general references are rejected by lifecycle state', async () => {
  for (const change of [
    { effectiveFrom: '2027-01-01T00:00:00Z' },
    { effectiveTo: '2026-09-09T10:00:00Z' },
    { status: 'inactive' }
  ]) {
    const data = fixtures();
    Object.assign(data.function[0], change);
    await rejects(() => setup(data).service.resolveBudgetReferences({
      budget: budget(), tenantId: TENANT, actorId: ACTOR
    }), 'BUDGET_REFERENCE_STATE_INVALID');
  }
});

test('read accepts explicitly retained archives while writes remain closed', async () => {
  const data = fixtures();
  Object.assign(data.country[0], { status: 'archived', historicalVisible: true });
  const { service } = setup(data);
  await rejects(() => service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR, operation: OPERATIONS.WRITE
  }), 'BUDGET_REFERENCE_STATE_INVALID');
  await assert.doesNotReject(() => service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR, operation: OPERATIONS.READ
  }));
});

test('read retains archived responsibility agents only under explicit historical visibility', async () => {
  const data = fixtures();
  Object.assign(data.agent[0], { status: 'archived', historicalVisible: true });
  const { service } = setup(data);
  await rejects(() => service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR, operation: OPERATIONS.WRITE
  }), 'BUDGET_RESPONSIBILITY_INVALID');
  await assert.doesNotReject(() => service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR, operation: OPERATIONS.READ
  }));

  data.agent[0].historicalVisible = false;
  await rejects(() => setup(data).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR, operation: OPERATIONS.READ
  }), 'BUDGET_RESPONSIBILITY_INVALID');
});

test('completed projects and closed phases require explicit historical visibility on reads', async () => {
  const data = fixtures();
  data.project[0].status = 'completed';
  data.phase[0].status = 'closed';
  await rejects(() => setup(data).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR, operation: OPERATIONS.READ
  }), 'BUDGET_REFERENCE_STATE_INVALID');
  data.project[0].historicalVisible = true;
  data.phase[0].historicalVisible = true;
  await assert.doesNotReject(() => setup(data).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR, operation: OPERATIONS.READ
  }));
});

test('fiscal-year lifecycle, calendar and period membership use the specialised code', async () => {
  const planned = fixtures();
  planned.fiscalYear[0].status = 'planned';
  await rejects(() => setup(planned).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_FISCAL_YEAR_INVALID');

  const brokenCalendar = fixtures();
  brokenCalendar.fiscalYear[0].periods[1].startDate = '2026-02-02';
  await rejects(() => setup(brokenCalendar).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_FISCAL_YEAR_INVALID');

  const openPeriod = fixtures();
  openPeriod.fiscalYear[0].periods[0].label = 'Janvier';
  await rejects(() => setup(openPeriod).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_FISCAL_YEAR_INVALID');

  const missingPeriods = fixtures();
  missingPeriods.fiscalYear[0].periods = null;
  await rejects(() => setup(missingPeriods).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_FISCAL_YEAR_INVALID');

  const numericYear = fixtures();
  numericYear.fiscalYear[0].summaryYear = 2026;
  await rejects(() => setup(numericYear).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_FISCAL_YEAR_INVALID');

  const notMonthly = fixtures();
  notMonthly.fiscalYear[0].periods = Array.from({ length: 12 }, (_, index) => ({
    periodId: `P${String(index + 1).padStart(2, '0')}`,
    ordinal: index + 1,
    startDate: index === 0 ? '2026-01-01' : `2026-01-${String(index + 1).padStart(2, '0')}`,
    endDate: index === 11 ? '2026-12-31' : `2026-01-${String(index + 1).padStart(2, '0')}`
  }));
  await rejects(() => setup(notMonthly).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_FISCAL_YEAR_INVALID');

  const wrongPeriods = budget();
  wrongPeriods.rows[0].periodValues[11].periodId = 'OTHER-P12';
  await rejects(() => setup().service.resolveBudgetReferences({
    budget: wrongPeriods, tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_FISCAL_YEAR_INVALID');
});

test('organisation and fiscal year must belong to the same entity', async () => {
  const data = fixtures();
  data.fiscalYear[0].entityId = 'ORG-OTHER';
  await rejects(() => setup(data).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_RELATION_INVALID');
});

test('portfolio, dossier, project and phase require their submitted canonical parent', async () => {
  for (const mutate of [
    data => { data.portfolio[0].functionId = 'other-function'; },
    data => { data.dossier[0].portfolioId = 'other-portfolio'; },
    data => { data.project[0].dossierId = 'other-dossier'; },
    data => { data.phase[0].projectId = 'other-project'; }
  ]) {
    const data = fixtures();
    mutate(data);
    await rejects(() => setup(data).service.resolveBudgetReferences({
      budget: budget(), tenantId: TENANT, actorId: ACTOR
    }), 'BUDGET_REFERENCE_RELATION_INVALID');
  }
});

test('team-agent coherence and responsibility eligibility are independently enforced', async () => {
  const wrongTeam = fixtures();
  wrongTeam.agent[0].teamId = 'TSN';
  await rejects(() => setup(wrongTeam).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_RESPONSIBILITY_INVALID');

  wrongTeam.portfolio[0].functionId = 'other-function';
  await rejects(() => setup(wrongTeam).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_RESPONSIBILITY_INVALID');

  const wrongRole = fixtures();
  wrongRole.agent[0].allowedResponsibilities = ['controllerAgentId'];
  await rejects(() => setup(wrongRole).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_RESPONSIBILITY_INVALID');
});

test('malformed resolver contracts and invalid caller context never fall through', async () => {
  const data = fixtures();
  data.portfolio[0].functionId = null;
  await rejects(() => setup(data).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_UNAVAILABLE');

  const missingFiscalParent = fixtures();
  missingFiscalParent.fiscalYear[0].entityId = null;
  await rejects(() => setup(missingFiscalParent).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }), 'BUDGET_REFERENCE_UNAVAILABLE');

  await rejects(() => setup().service.resolveBudgetReferences({
    budget: budget(), tenantId: '', actorId: ACTOR
  }), 'BUDGET_REQUEST_INVALID');

  for (const timestamp of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z']) {
    const invalidTimestamp = fixtures();
    invalidTimestamp.entity[0].effectiveFrom = timestamp;
    await rejects(() => setup(invalidTimestamp).service.resolveBudgetReferences({
      budget: budget(), tenantId: TENANT, actorId: ACTOR
    }), 'BUDGET_REFERENCE_UNAVAILABLE');
  }

  const preciseTimestamp = fixtures();
  preciseTimestamp.entity[0].effectiveFrom = '2025-01-01T00:00:00.123456789Z';
  await assert.doesNotReject(() => setup(preciseTimestamp).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }));

  const preciseInterval = fixtures();
  preciseInterval.entity[0].effectiveFrom = '2026-09-09T09:59:59.123456789Z';
  preciseInterval.entity[0].effectiveTo = '2026-09-09T10:00:00.000000001Z';
  await assert.doesNotReject(() => setup(preciseInterval).service.resolveBudgetReferences({
    budget: budget(), tenantId: TENANT, actorId: ACTOR
  }));
});

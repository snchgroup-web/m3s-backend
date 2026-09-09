const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MAX_VERSION } = require('../financeBudgetV2Contracts');
const { createBudgetReferenceService } = require('../financeBudgetV2References');
const { createBudgetV2ReadService } = require('../financeBudgetV2Reads');
const { createBudgetV2WriteService } = require('../financeBudgetV2Writes');
const { createFakeBudgetReferenceResolver } = require('./helpers/fakeBudgetReferenceResolver');
const { createFakeBudgetV2WriteStorage } = require('./helpers/fakeBudgetV2WriteStorage');

const TENANT = 'tenant-2sg';
const ACTOR = 'user-cheikh';
const FIRST_AT = new Date('2026-09-09T10:00:00.000Z');
const SECOND_AT = new Date('2026-09-10T11:30:00.000Z');
const ID = '00000000-0000-4000-8000-000000000101';

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

function fixtureRecords() {
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
    project: [base('PROJ-1', { dossierId: 'DOS-1' })],
    phase: [base('PHASE-1', { status: 'open', projectId: 'PROJ-1' })]
  };
}

function budget(title = 'Budget 2SG 2026') {
  return {
    title,
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

function createBody(title) {
  return { contractVersion: 2, budget: budget(title) };
}

function updateBody(version, title) {
  return { contractVersion: 2, budget: budget(title), expectedVersion: version };
}

function resolversFrom(records) {
  return Object.fromEntries(Object.entries(records).map(([type, values]) => [
    type, createFakeBudgetReferenceResolver(values)
  ]));
}

function input(body, overrides = {}) {
  return {
    tenantId: TENANT,
    actorId: ACTOR,
    v2Enabled: true,
    financeRead: true,
    financeWrite: true,
    body,
    ...overrides
  };
}

function setup({
  records = [],
  storageOptions = {},
  referenceRecords = fixtureRecords(),
  now = FIRST_AT,
  uuid = ID,
  referenceServiceFactory
} = {}) {
  const storage = createFakeBudgetV2WriteStorage(records, storageOptions);
  const factories = [];
  const resolverSets = [];
  let clockCalls = 0;
  let uuidCalls = 0;
  const factory = referenceServiceFactory || (context => {
    factories.push(context);
    const resolvers = resolversFrom(referenceRecords);
    resolverSets.push(resolvers);
    return createBudgetReferenceService({
      resolvers,
      clock: () => new Date(context.writeAt.getTime())
    });
  });
  const service = createBudgetV2WriteService({
    storage,
    referenceServiceFactory: factory,
    clock: () => {
      clockCalls += 1;
      return new Date(now);
    },
    uuidGenerator: () => {
      uuidCalls += 1;
      return uuid;
    }
  });
  return {
    service,
    storage,
    factories,
    resolverSets,
    clockCalls: () => clockCalls,
    uuidCalls: () => uuidCalls
  };
}

async function makeRecord({
  id = ID,
  version = 1,
  title = 'Budget 2SG 2026',
  createdAt = FIRST_AT.toISOString(),
  updatedAt = FIRST_AT.toISOString(),
  tenantId = TENANT,
  authorUserId = ACTOR
} = {}) {
  const sourceBudget = budget(title);
  const snapshots = await createBudgetReferenceService({
    resolvers: resolversFrom(fixtureRecords()),
    clock: () => new Date(updatedAt)
  }).resolveBudgetReferences({
    budget: sourceBudget,
    tenantId: TENANT,
    actorId: ACTOR,
    operation: 'write'
  });
  return {
    id, tenantId, authorUserId, version, title,
    entity: 'Reference ORG-2SG', year: '2026', createdAt, updatedAt,
    scope: 'organization', status: 'draft', access: 'owner-only',
    document: { contractVersion: 2, budget: sourceBudget, referenceSnapshots: snapshots }
  };
}

async function rejects(run, code) {
  await assert.rejects(run, error => error && error.code === code);
}

test('create builds one canonical V2 record and one atomic audit event', async () => {
  const state = setup();
  const result = await state.service.createDraft(input(createBody('Budget initial')));

  assert.deepEqual(Object.keys(result), ['success', 'contractVersion', 'data']);
  assert.deepEqual(Object.keys(result.data), [
    'id', 'version', 'title', 'entity', 'year', 'createdAt', 'updatedAt',
    'scope', 'status', 'access'
  ]);
  assert.equal(result.data.id, ID);
  assert.equal(result.data.version, 1);
  assert.equal(result.data.createdAt, FIRST_AT.toISOString());
  assert.equal(result.data.updatedAt, FIRST_AT.toISOString());
  assert.equal(state.clockCalls(), 1);
  assert.equal(state.uuidCalls(), 1);
  assert.equal(state.factories.length, 1);
  assert.equal(state.factories[0].writeAt.toISOString(), FIRST_AT.toISOString());
  const stored = state.storage.state.records.get(ID);
  assert.equal(stored.document.referenceSnapshots.identity.entityId.resolvedAt,
    FIRST_AT.toISOString());
  assert.deepEqual(state.storage.state.auditEvents, [{
    action: 'budget_v2_draft_created', draftId: ID, version: 1,
    occurredAt: FIRST_AT.toISOString()
  }]);
  const calls = Object.values(state.resolverSets[0]).flatMap(resolver => resolver.calls);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.operation === 'write'
    && call.resolvedAt === FIRST_AT.toISOString()));
});

test('update replaces snapshots, preserves createdAt and increments exactly once', async () => {
  const current = await makeRecord();
  const state = setup({ records: [current], now: SECOND_AT });
  const result = await state.service.updateDraft({
    id: ID,
    ...input(updateBody(1, 'Budget revise'))
  });

  assert.equal(result.data.version, 2);
  assert.equal(result.data.title, 'Budget revise');
  assert.equal(result.data.createdAt, FIRST_AT.toISOString());
  assert.equal(result.data.updatedAt, SECOND_AT.toISOString());
  const stored = state.storage.state.records.get(ID);
  assert.equal(stored.version, 2);
  assert.equal(stored.createdAt, FIRST_AT.toISOString());
  assert.equal(stored.document.referenceSnapshots.identity.entityId.resolvedAt,
    SECOND_AT.toISOString());
  assert.deepEqual(state.storage.state.auditEvents, [{
    action: 'budget_v2_draft_updated', draftId: ID, version: 2,
    occurredAt: SECOND_AT.toISOString()
  }]);
  assert.equal(state.clockCalls(), 1);
});

test('syntax, authentication, capability and permissions precede storage', async () => {
  const invalid = setup();
  await rejects(() => invalid.service.createDraft(input({ contractVersion: 1 })),
    'BUDGET_REQUEST_INVALID');
  assert.equal(invalid.storage.state.calls.length, 0);

  const auth = setup();
  await rejects(() => auth.service.createDraft(input(createBody(), { actorId: '' })),
    'BUDGET_AUTH_REQUIRED');
  assert.equal(auth.storage.state.calls.length, 0);

  const capability = setup();
  await rejects(() => capability.service.createDraft(input(createBody(), {
    v2Enabled: false, financeRead: false, financeWrite: false
  })), 'BUDGET_V2_DISABLED');
  assert.equal(capability.storage.state.calls.length, 0);

  const rights = setup();
  await rejects(() => rights.service.createDraft(input(createBody(), { financeWrite: false })),
    'BUDGET_ACCESS_DENIED');
  assert.equal(rights.storage.state.calls.length, 0);
});

test('storage probe precedes clock, UUID and reference resolution', async () => {
  for (const storageOptions of [
    { probeThrows: true },
    { probeResult: { available: false } },
    { probeResult: { available: true, extra: true } }
  ]) {
    const state = setup({ storageOptions });
    await rejects(() => state.service.createDraft(input(createBody())),
      'BUDGET_STORAGE_UNAVAILABLE');
    assert.equal(state.clockCalls(), 0);
    assert.equal(state.uuidCalls(), 0);
    assert.equal(state.factories.length, 0);
  }
});

test('invalid clock and invalid UUID fail closed before reference access', async () => {
  const badClockStorage = createFakeBudgetV2WriteStorage();
  const badClock = createBudgetV2WriteService({
    storage: badClockStorage,
    referenceServiceFactory: () => assert.fail('reference factory called'),
    clock: () => new Date(NaN),
    uuidGenerator: () => ID
  });
  await rejects(() => badClock.createDraft(input(createBody())),
    'BUDGET_STORAGE_UNAVAILABLE');

  const badUuid = setup({ uuid: 'not-an-uuid' });
  await rejects(() => badUuid.service.createDraft(input(createBody())),
    'BUDGET_STORAGE_UNAVAILABLE');
  assert.equal(badUuid.factories.length, 0);
});

test('reference failures remain specialised and unknown failures close safely', async () => {
  const missing = fixtureRecords();
  missing.entity = [];
  const state = setup({ referenceRecords: missing });
  await rejects(() => state.service.createDraft(input(createBody())),
    'BUDGET_REFERENCE_NOT_FOUND');
  assert.equal(state.storage.state.calls.some(call => call.method === 'createCurrentDraft'), false);

  const unknown = setup({
    referenceServiceFactory: () => ({
      async resolveBudgetReferences() {
        const error = new Error('private');
        error.code = 'PRIVATE_DEPENDENCY_ERROR';
        throw error;
      }
    })
  });
  await rejects(() => unknown.service.createDraft(input(createBody())),
    'BUDGET_REFERENCE_UNAVAILABLE');
});

test('all references are resolved before an update version conflict', async () => {
  const current = await makeRecord({ version: 2 });
  const state = setup({ records: [current], now: SECOND_AT });
  await rejects(() => state.service.updateDraft({
    id: ID,
    ...input(updateBody(1, 'Version obsolete'))
  }), 'BUDGET_VERSION_CONFLICT');
  assert.equal(state.factories.length, 1);
  assert.ok(Object.values(state.resolverSets[0]).some(resolver => resolver.calls.length > 0));
  assert.equal(state.storage.state.calls.some(call => call.method === 'replaceCurrentDraft'), false);
});

test('a terminal stored version precedes expected-version conflict', async () => {
  const current = await makeRecord({ version: MAX_VERSION });
  const state = setup({ records: [current], now: SECOND_AT });
  await rejects(() => state.service.updateDraft({
    id: ID,
    ...input(updateBody(MAX_VERSION - 1, 'Interdit'))
  }), 'BUDGET_VERSION_LIMIT');
  assert.equal(state.storage.state.calls.some(call => call.method === 'replaceCurrentDraft'), false);
});

test('update hides absent, V1, cross-tenant and cross-author records', async () => {
  const absent = setup({ now: SECOND_AT });
  await rejects(() => absent.service.updateDraft({ id: ID, ...input(updateBody(1)) }),
    'BUDGET_DRAFT_NOT_FOUND');

  const v1 = await makeRecord();
  v1.document = { budget: { title: 'V1' } };
  await rejects(() => setup({ records: [v1], now: SECOND_AT }).service.updateDraft({
    id: ID, ...input(updateBody(1))
  }), 'BUDGET_DRAFT_NOT_FOUND');

  for (const overrides of [{ tenantId: 'other' }, { authorUserId: 'other' }]) {
    const record = await makeRecord(overrides);
    await rejects(() => setup({ records: [record], now: SECOND_AT }).service.updateDraft({
      id: ID, ...input(updateBody(1))
    }), 'BUDGET_DRAFT_NOT_FOUND');
  }
});

test('ambiguous lookup and promotion state fail without writes', async () => {
  const current = await makeRecord();
  const duplicate = setup({
    records: [current],
    now: SECOND_AT,
    storageOptions: { getResult: { available: true, records: [current, current] } }
  });
  await rejects(() => duplicate.service.updateDraft({ id: ID, ...input(updateBody(1)) }),
    'BUDGET_STORAGE_UNAVAILABLE');
  assert.equal(duplicate.factories.length, 0);

  const linked = setup({
    records: [current],
    now: SECOND_AT,
    storageOptions: { promotionLinks: [{ draftId: ID }] }
  });
  await rejects(() => linked.service.updateDraft({ id: ID, ...input(updateBody(1)) }),
    'BUDGET_STORAGE_UNAVAILABLE');
  assert.equal(linked.storage.state.calls.some(call => call.method === 'replaceCurrentDraft'), false);

  current.document.promotion = {};
  const block = setup({ records: [current], now: SECOND_AT });
  await rejects(() => block.service.updateDraft({ id: ID, ...input(updateBody(1)) }),
    'BUDGET_STORAGE_UNAVAILABLE');
});

test('certain create outcomes never leave partial records or audit events', async () => {
  for (const [result, code] of [
    [{ outcome: 'duplicate' }, 'BUDGET_STORAGE_UNAVAILABLE'],
    [{ outcome: 'unavailable' }, 'BUDGET_STORAGE_UNAVAILABLE'],
    [{ outcome: 'missing' }, 'BUDGET_DRAFT_NOT_FOUND'],
    [{ outcome: 'conflict' }, 'BUDGET_VERSION_CONFLICT']
  ]) {
    const state = setup({ storageOptions: { createOutcome: result } });
    await rejects(() => state.service.createDraft(input(createBody())), code);
    assert.equal(state.storage.state.records.size, 0);
    assert.equal(state.storage.state.auditEvents.length, 0);
  }
});

test('uncertain or thrown create returns only reconciliation metadata and never retries', async () => {
  for (const storageOptions of [
    { createOutcome: { outcome: 'uncertain' } },
    { createOutcome: { outcome: 'unknown' } },
    { createOutcome: { outcome: 'created', id: ID, version: 2 } },
    { createThrows: true }
  ]) {
    const state = setup({ storageOptions });
    await assert.rejects(
      () => state.service.createDraft(input(createBody())),
      error => error.code === 'BUDGET_WRITE_UNCERTAIN'
        && error.draftId === ID && error.reconcileRequired === true
    );
    assert.equal(state.storage.state.calls.filter(
      call => call.method === 'createCurrentDraft'
    ).length, 1);
  }
});

test('replace outcomes are classified without retry or partial audit', async () => {
  const current = await makeRecord();
  for (const [result, code] of [
    [{ outcome: 'missing' }, 'BUDGET_DRAFT_NOT_FOUND'],
    [{ outcome: 'conflict' }, 'BUDGET_VERSION_CONFLICT'],
    [{ outcome: 'duplicate' }, 'BUDGET_STORAGE_UNAVAILABLE'],
    [{ outcome: 'unavailable' }, 'BUDGET_STORAGE_UNAVAILABLE']
  ]) {
    const state = setup({
      records: [current], now: SECOND_AT, storageOptions: { replaceOutcome: result }
    });
    await rejects(() => state.service.updateDraft({ id: ID, ...input(updateBody(1)) }), code);
    assert.equal(state.storage.state.records.get(ID).version, 1);
    assert.equal(state.storage.state.auditEvents.length, 0);
  }
});

test('uncertain or thrown replace returns reconciliation metadata and never retries', async () => {
  const current = await makeRecord();
  for (const storageOptions of [
    { replaceOutcome: { outcome: 'uncertain' } },
    { replaceOutcome: { outcome: 'updated', id: ID, version: 3 } },
    { replaceThrows: true }
  ]) {
    const state = setup({ records: [current], now: SECOND_AT, storageOptions });
    await assert.rejects(
      () => state.service.updateDraft({ id: ID, ...input(updateBody(1)) }),
      error => error.code === 'BUDGET_WRITE_UNCERTAIN'
        && error.draftId === ID && error.reconcileRequired === true
    );
    assert.equal(state.storage.state.calls.filter(
      call => call.method === 'replaceCurrentDraft'
    ).length, 1);
  }
});

test('two concurrent updates of one version produce exactly one success', async () => {
  const current = await makeRecord();
  const state = setup({ records: [current], now: SECOND_AT });
  const command = { id: ID, ...input(updateBody(1, 'Concurrent')) };
  const results = await Promise.allSettled([
    state.service.updateDraft(structuredClone(command)),
    state.service.updateDraft(structuredClone(command))
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected'
    && result.reason.code === 'BUDGET_VERSION_CONFLICT').length, 1);
  assert.equal(state.storage.state.records.get(ID).version, 2);
  assert.equal(state.storage.state.auditEvents.length, 1);
});

test('caller and storage mutations cannot contaminate the command result', async () => {
  let releaseProbe;
  const storage = createFakeBudgetV2WriteStorage([], { mutateCreateArguments: true });
  storage.probe = () => new Promise(resolve => { releaseProbe = resolve; });
  const state = createBudgetV2WriteService({
    storage,
    referenceServiceFactory: context => createBudgetReferenceService({
      resolvers: resolversFrom(fixtureRecords()),
      clock: () => new Date(context.writeAt)
    }),
    clock: () => new Date(FIRST_AT),
    uuidGenerator: () => ID
  });
  const body = createBody('Titre stable');
  const pending = state.createDraft(input(body));
  body.budget.title = 'Mutation appelant';
  releaseProbe({ available: true });
  const result = await pending;
  assert.equal(result.data.title, 'Titre stable');
  assert.equal(storage.state.records.get(ID).title, 'Titre stable');
  assert.equal(storage.state.auditEvents[0].action, 'budget_v2_draft_created');
});

test('snapshots at another instant are rejected before storage write', async () => {
  const state = setup({
    referenceServiceFactory: () => createBudgetReferenceService({
      resolvers: resolversFrom(fixtureRecords()),
      clock: () => new Date(SECOND_AT)
    })
  });
  await rejects(() => state.service.createDraft(input(createBody())),
    'BUDGET_STORAGE_UNAVAILABLE');
  assert.equal(state.storage.state.calls.some(call => call.method === 'createCurrentDraft'), false);
});

test('a record created by T1-D-A is readable by the shared T1-C-A validator', async () => {
  const state = setup();
  await state.service.createDraft(input(createBody()));
  const record = state.storage.state.records.get(ID);
  const readStorage = {
    async getCurrentDraft() {
      return { available: true, records: [structuredClone(record)] };
    },
    async findPromotionLinks() {
      return { available: true, records: [] };
    }
  };
  const reader = createBudgetV2ReadService({
    storage: readStorage,
    referenceServiceFactory: context => createBudgetReferenceService({
      resolvers: resolversFrom(fixtureRecords()),
      clock: () => new Date(context.requestAt)
    }),
    clock: () => new Date(SECOND_AT)
  });
  const result = await reader.readDraft({
    id: ID, tenantId: TENANT, actorId: ACTOR, v2Enabled: true, financeRead: true
  });
  assert.equal(result.data.id, ID);
  assert.equal(result.data.version, 1);
});

test('the pure lot contains no route, cloud, environment or SQL dependency', () => {
  for (const filename of ['financeBudgetV2Writes.js', 'financeBudgetV2StoredRecords.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    assert.doesNotMatch(source, /require\(['"]express['"]\)/i);
    assert.doesNotMatch(
      source,
      /@google-cloud|bigquery|process\.env|current_timestamp|\bselect\s+.+\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b/i
    );
  }
});

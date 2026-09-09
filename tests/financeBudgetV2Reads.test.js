const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIST_BATCH_SIZE,
  MAX_LIST_CANDIDATES,
  MAX_LIST_POSITIONS,
  MAX_LIST_SCAN_BYTES,
  createBudgetV2ReadService
} = require('../financeBudgetV2Reads');
const { createBudgetReferenceService } = require('../financeBudgetV2References');
const { createFakeBudgetReferenceResolver } = require('./helpers/fakeBudgetReferenceResolver');

const TENANT = 'tenant-2sg';
const ACTOR = 'user-cheikh';
const STORED_AT = new Date('2026-09-09T10:00:00.000Z');
const REQUEST_AT = new Date('2026-09-10T10:00:00.000Z');
const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004'
];

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

function resolversFrom(records) {
  return Object.fromEntries(Object.entries(records).map(([type, values]) => [
    type, createFakeBudgetReferenceResolver(values)
  ]));
}

async function makeRecord({ id = IDS[0], version = 1, title = 'Budget 2SG 2026',
  createdAt = STORED_AT.toISOString(), updatedAt = STORED_AT.toISOString(),
  tenantId = TENANT, authorUserId = ACTOR } = {}) {
  const sourceBudget = budget(title);
  const snapshots = await createBudgetReferenceService({
    resolvers: resolversFrom(fixtureRecords()),
    clock: () => new Date(updatedAt)
  }).resolveBudgetReferences({
    budget: sourceBudget, tenantId: TENANT, actorId: ACTOR, operation: 'write'
  });
  return {
    id, tenantId, authorUserId, version, title,
    entity: 'Reference ORG-2SG', year: '2026', createdAt, updatedAt,
    scope: 'organization', status: 'draft', access: 'owner-only',
    document: { contractVersion: 2, budget: sourceBudget, referenceSnapshots: snapshots }
  };
}

function bytes(record) {
  return Buffer.byteLength(JSON.stringify(record.document), 'utf8');
}

function createStorage(records, options = {}) {
  const state = { loads: 0, scans: [], promotionCalls: [] };
  return {
    state,
    async getCurrentDraft({ id }) {
      if (options.getUnavailable) return { available: false };
      if (options.getDuplicate) return { available: true, records: [records[0], records[0]] };
      return { available: true, records: records.filter(record => record.id === id) };
    },
    async findPromotionLinks(query) {
      state.promotionCalls.push(query);
      if (options.linkUnavailable) return { available: false };
      return { available: true, records: options.links || [] };
    },
    async *scanCurrentDrafts(query) {
      state.scans.push(query);
      const handles = records.map((record, index) => ({
        id: record.id,
        updatedAt: record.updatedAt,
        serializedBytes: options.serializedBytes?.[index] ?? bytes(record),
        async load() {
          state.loads += 1;
          if (options.loadFailureAt === index) throw new Error('fake load failure');
          return record;
        }
      }));
      const batchSize = options.batchSize || LIST_BATCH_SIZE;
      for (let index = 0; index < handles.length; index += batchSize) {
        yield handles.slice(index, index + batchSize);
      }
    }
  };
}

function createSetup(records, options = {}) {
  const storage = options.storage || createStorage(records, options.storageOptions);
  const referenceRecords = options.referenceRecords || fixtureRecords();
  const factories = [];
  const referenceServiceFactory = context => {
    const resolvers = resolversFrom(referenceRecords);
    const service = createBudgetReferenceService({ resolvers });
    factories.push({ context, resolvers, service });
    return service;
  };
  let clockCalls = 0;
  const service = createBudgetV2ReadService({
    storage,
    referenceServiceFactory: options.referenceServiceFactory || referenceServiceFactory,
    clock: () => {
      clockCalls += 1;
      return new Date(REQUEST_AT);
    }
  });
  return { service, storage, factories, clockCalls: () => clockCalls };
}

function detailInput(overrides = {}) {
  return {
    id: IDS[0], tenantId: TENANT, actorId: ACTOR,
    v2Enabled: true, financeRead: true, ...overrides
  };
}

function listInput(overrides = {}) {
  return {
    tenantId: TENANT, actorId: ACTOR,
    v2Enabled: true, financeRead: true, ...overrides
  };
}

async function rejects(run, code) {
  await assert.rejects(run, error => error && error.code === code);
}

test('detail returns only the validated V2 document and uses one request instant', async () => {
  const record = await makeRecord();
  const before = structuredClone(record);
  const setup = createSetup([record]);

  const result = await setup.service.readDraft(detailInput());

  assert.deepEqual(Object.keys(result), ['success', 'contractVersion', 'data']);
  assert.deepEqual(Object.keys(result.data), [
    'id', 'version', 'title', 'entity', 'year', 'createdAt', 'updatedAt',
    'scope', 'status', 'access', 'budget', 'referenceSnapshots'
  ]);
  assert.equal(result.contractVersion, 2);
  assert.equal(result.data.budget.title, record.title);
  assert.equal(setup.clockCalls(), 1);
  assert.equal(setup.factories.length, 1);
  assert.equal(setup.factories[0].context.requestAt.toISOString(), REQUEST_AT.toISOString());
  const calls = Object.values(setup.factories[0].resolvers).flatMap(resolver => resolver.calls);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.operation === 'read'
    && call.resolvedAt === REQUEST_AT.toISOString()));
  assert.deepEqual(record, before);
  result.data.budget.title = 'Mutation externe';
  assert.equal(record.document.budget.title, 'Budget 2SG 2026');
});

test('request controls are closed and preserve syntax, auth, capability and permission order', async () => {
  const record = await makeRecord();
  const { service } = createSetup([record]);
  await rejects(() => service.readDraft(detailInput({ id: 'bad', actorId: '' })), 'BUDGET_REQUEST_INVALID');
  await rejects(() => service.readDraft(detailInput({ actorId: '' })), 'BUDGET_AUTH_REQUIRED');
  await rejects(() => service.readDraft(detailInput({ v2Enabled: false, financeRead: false })), 'BUDGET_V2_DISABLED');
  await rejects(() => service.readDraft(detailInput({ financeRead: false })), 'BUDGET_ACCESS_DENIED');
  await rejects(() => service.listDrafts(listInput({ limit: 0 })), 'BUDGET_REQUEST_INVALID');
  await rejects(() => service.listDrafts({ ...listInput(), inconnu: true }), 'BUDGET_REQUEST_INVALID');
});

test('detail hides absent, V1, cross-tenant and cross-author records before reference calls', async () => {
  const absent = createSetup([]);
  await rejects(() => absent.service.readDraft(detailInput()), 'BUDGET_DRAFT_NOT_FOUND');
  assert.equal(absent.factories.length, 0);

  const v1 = await makeRecord();
  v1.document = { budget: { title: 'V1' } };
  const v1Setup = createSetup([v1]);
  await rejects(() => v1Setup.service.readDraft(detailInput()), 'BUDGET_DRAFT_NOT_FOUND');
  assert.equal(v1Setup.factories.length, 0);

  for (const override of [{ tenantId: 'tenant-other' }, { authorUserId: 'user-other' }]) {
    const record = await makeRecord(override);
    const setup = createSetup([record]);
    await rejects(() => setup.service.readDraft(detailInput()), 'BUDGET_DRAFT_NOT_FOUND');
    assert.equal(setup.factories.length, 0);
  }
});

test('detail fails closed for unavailable, duplicate or malformed storage', async () => {
  const record = await makeRecord();
  await rejects(
    () => createSetup([record], { storageOptions: { getUnavailable: true } })
      .service.readDraft(detailInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  await rejects(
    () => createSetup([record], { storageOptions: { getDuplicate: true } })
      .service.readDraft(detailInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  const malformed = structuredClone(record);
  malformed.unknown = true;
  await rejects(
    () => createSetup([malformed]).service.readDraft(detailInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  const mismatched = await makeRecord({ id: IDS[1] });
  const mismatchedStorage = createStorage([mismatched]);
  mismatchedStorage.getCurrentDraft = async () => ({ available: true, records: [mismatched] });
  await rejects(
    () => createSetup([mismatched], { storage: mismatchedStorage })
      .service.readDraft(detailInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  mismatched.tenantId = 'tenant-other';
  await rejects(
    () => createSetup([mismatched], { storage: mismatchedStorage })
      .service.readDraft(detailInput()),
    'BUDGET_DRAFT_NOT_FOUND'
  );
  delete mismatched.id;
  await rejects(
    () => createSetup([mismatched], { storage: mismatchedStorage })
      .service.readDraft(detailInput()),
    'BUDGET_DRAFT_NOT_FOUND'
  );
});

test('reference refusal precedes an independent stored title corruption', async () => {
  const record = await makeRecord();
  record.title = 'Resume divergent';
  record.unknown = true;
  const hidden = fixtureRecords();
  hidden.entity[0].visible = false;
  const setup = createSetup([record], { referenceRecords: hidden });

  await rejects(() => setup.service.readDraft(detailInput()), 'BUDGET_REFERENCE_NOT_FOUND');
});

test('stored integrity rejects inconsistent summary, timeline, snapshots, periods and relations', async t => {
  const cases = [
    ['summary title', record => { record.title = 'Divergent'; }],
    ['future timestamp', record => { record.updatedAt = '2026-09-11T10:00:00.000Z'; }],
    ['invalid calendar timestamp', record => { record.createdAt = '2026-02-30T10:00:00.000Z'; }],
    ['multiple resolvedAt', record => {
      record.document.referenceSnapshots.rows[0].dimensions.countryId.resolvedAt =
        '2026-09-09T10:00:01.000Z';
    }],
    ['period divergence', record => {
      record.document.referenceSnapshots.identity.fiscalYearId.periods[0].periodId = 'OTHER';
    }],
    ['parent contradiction', record => {
      record.document.referenceSnapshots.rows[0].dimensions.projectId.dossierId = 'DOS-OTHER';
    }],
    ['open root envelope', record => { record.document.extra = true; }],
    ['wrong scope', record => { record.scope = 'personal'; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const record = await makeRecord();
      mutate(record);
      await rejects(
        () => createSetup([record]).service.readDraft(detailInput()),
        'BUDGET_STORAGE_UNAVAILABLE'
      );
    });
  }
});

test('period values remain an unordered complete set as allowed by T1-A', async () => {
  const record = await makeRecord();
  record.document.budget.rows[0].periodValues.reverse();

  const result = await createSetup([record]).service.readDraft(detailInput());

  assert.equal(result.data.budget.rows[0].periodValues[0].periodId, 'P12');
});

test('unknown dependency error codes are closed as reference unavailable', async () => {
  const record = await makeRecord();
  const referenceServiceFactory = () => ({
    async resolveStoredBudgetReferences() {
      const error = new Error('private dependency detail');
      error.code = 'INTERNAL_PRIVATE_CODE';
      throw error;
    }
  });
  const setup = createSetup([record], { referenceServiceFactory });

  await rejects(
    () => setup.service.readDraft(detailInput()),
    'BUDGET_REFERENCE_UNAVAILABLE'
  );
});

test('promotion remains closed before T1-E for a block, link or unavailable link source', async () => {
  const withBlock = await makeRecord();
  withBlock.document.promotion = {};
  await rejects(
    () => createSetup([withBlock]).service.readDraft(detailInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  const record = await makeRecord();
  await rejects(
    () => createSetup([record], { storageOptions: { links: [{ id: 'link-1' }] } })
      .service.readDraft(detailInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  await rejects(
    () => createSetup([record], { storageOptions: { linkUnavailable: true } })
      .service.readDraft(detailInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
});

test('terminal version remains readable while invalid versions and update chronology fail closed', async () => {
  const terminal = await makeRecord({
    version: 1000000,
    createdAt: '2026-01-01T10:00:00.000Z'
  });
  const result = await createSetup([terminal]).service.readDraft(detailInput());
  assert.equal(result.data.version, 1000000);

  for (const version of [0, 1000001]) {
    const record = await makeRecord({ version });
    await rejects(
      () => createSetup([record]).service.readDraft(detailInput()),
      'BUDGET_STORAGE_UNAVAILABLE'
    );
  }
  const reversed = await makeRecord({
    version: 2,
    createdAt: '2026-09-09T10:00:00.001Z'
  });
  await rejects(
    () => createSetup([reversed]).service.readDraft(detailInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
});

test('list filters before pagination, returns ten summary fields and shares T1-B.1 cache', async () => {
  const first = await makeRecord({ id: IDS[0], title: 'Premier',
    updatedAt: '2026-09-09T12:00:00.000Z', createdAt: '2026-09-09T12:00:00.000Z' });
  const hidden = await makeRecord({ id: IDS[1], title: 'Masque',
    updatedAt: '2026-09-09T11:00:00.000Z', createdAt: '2026-09-09T11:00:00.000Z' });
  hidden.tenantId = 'tenant-other';
  const third = await makeRecord({ id: IDS[2], title: 'Troisieme',
    updatedAt: '2026-09-09T10:00:00.000Z' });
  const fourth = await makeRecord({ id: IDS[3], title: 'Quatrieme',
    updatedAt: '2026-09-09T09:00:00.000Z', createdAt: '2026-09-09T09:00:00.000Z' });
  const setup = createSetup([first, hidden, third, fourth]);

  const result = await setup.service.listDrafts(listInput({ offset: 1, limit: 1 }));

  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, IDS[2]);
  assert.deepEqual(Object.keys(result.data[0]), [
    'id', 'version', 'title', 'entity', 'year', 'createdAt', 'updatedAt',
    'scope', 'status', 'access'
  ]);
  assert.equal(result.hasMore, true);
  assert.equal(setup.factories.length, 1);
  assert.equal(setup.factories[0].resolvers.entity.calls.length, 1);
  assert.equal(setup.clockCalls(), 1);
  assert.deepEqual(setup.storage.state.scans[0], {
    tenantId: TENANT, authorUserId: ACTOR,
    batchSize: 50, maxPositions: MAX_LIST_POSITIONS
  });
});

test('list omits draft-specific reference errors but blocks a source outage without partial success', async () => {
  const records = [
    await makeRecord({ id: IDS[0], updatedAt: '2026-09-09T12:00:00.000Z',
      createdAt: '2026-09-09T12:00:00.000Z' }),
    await makeRecord({ id: IDS[1], updatedAt: '2026-09-09T11:00:00.000Z',
      createdAt: '2026-09-09T11:00:00.000Z' })
  ];
  records[0].document.budget.identity.entityId = 'ORG-HIDDEN';
  records[0].document.referenceSnapshots.identity.entityId.id = 'ORG-HIDDEN';
  const setup = createSetup(records);
  const result = await setup.service.listDrafts(listInput());
  assert.deepEqual(result.data.map(item => item.id), [IDS[1]]);

  const unavailableFactory = () => ({
    async resolveStoredBudgetReferences() {
      const error = new Error('source unavailable');
      error.code = 'BUDGET_REFERENCE_UNAVAILABLE';
      throw error;
    }
  });
  const outage = createSetup(records, { referenceServiceFactory: unavailableFactory });
  await rejects(() => outage.service.listDrafts(listInput()), 'BUDGET_REFERENCE_UNAVAILABLE');
});

test('list blocks a later source outage instead of returning an earlier partial result', async () => {
  const records = [
    await makeRecord({ id: IDS[0], updatedAt: '2026-09-09T12:00:00.000Z',
      createdAt: '2026-09-09T12:00:00.000Z' }),
    await makeRecord({ id: IDS[1], updatedAt: '2026-09-09T11:00:00.000Z',
      createdAt: '2026-09-09T11:00:00.000Z' })
  ];
  let calls = 0;
  const referenceServiceFactory = () => ({
    async resolveStoredBudgetReferences() {
      calls += 1;
      if (calls === 2) {
        const error = new Error('later source outage');
        error.code = 'BUDGET_REFERENCE_UNAVAILABLE';
        throw error;
      }
      return {};
    }
  });
  const setup = createSetup(records, { referenceServiceFactory });

  await rejects(
    () => setup.service.listDrafts(listInput()),
    'BUDGET_REFERENCE_UNAVAILABLE'
  );
  assert.equal(calls, 2);
});

test('list breaks equal timestamps by ascending id and rejects the reverse order', async () => {
  const first = await makeRecord({ id: IDS[0] });
  const second = await makeRecord({ id: IDS[1] });
  const result = await createSetup([first, second]).service.listDrafts(listInput());
  assert.deepEqual(result.data.map(item => item.id), [IDS[0], IDS[1]]);

  await rejects(
    () => createSetup([second, first]).service.listDrafts(listInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
});

test('list omits an out-of-scope record before requiring its ordering metadata', async () => {
  const foreign = await makeRecord({ tenantId: 'tenant-other' });
  const storage = createStorage([foreign]);
  storage.scanCurrentDrafts = async function* scan() {
    yield [{
      serializedBytes: bytes(foreign),
      async load() {
        storage.state.loads += 1;
        return foreign;
      }
    }];
  };
  const setup = createSetup([foreign], { storage });

  const result = await setup.service.listDrafts(listInput());

  assert.deepEqual(result, { success: true, contractVersion: 2, data: [], hasMore: false });
  assert.equal(setup.factories.length, 0);
});

test('list rejects wrong order, duplicate ids, oversized batches and load inconsistencies', async () => {
  const late = await makeRecord({ id: IDS[0], updatedAt: '2026-09-09T09:00:00.000Z',
    createdAt: '2026-09-09T09:00:00.000Z' });
  const early = await makeRecord({ id: IDS[1], updatedAt: '2026-09-09T10:00:00.000Z' });
  await rejects(
    () => createSetup([late, early]).service.listDrafts(listInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  await rejects(
    () => createSetup([early, structuredClone(early)]).service.listDrafts(listInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  const oversized = createStorage([early]);
  oversized.scanCurrentDrafts = async function* scan() {
    yield Array.from({ length: 51 }, () => ({}));
  };
  await rejects(
    () => createSetup([early], { storage: oversized }).service.listDrafts(listInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
  await rejects(
    () => createSetup([early], { storageOptions: { serializedBytes: [bytes(early) + 1] } })
      .service.listDrafts(listInput()),
    'BUDGET_STORAGE_UNAVAILABLE'
  );
});

function boundedId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

test('list inspects at most 10051 candidates and never loads sentinel 10052', async () => {
  const template = await makeRecord();
  template.document = { budget: { title: 'V1' } };
  const records = Array.from({ length: MAX_LIST_POSITIONS }, (_, index) => ({
    ...template,
    id: boundedId(index + 1)
  }));
  const setup = createSetup(records);

  await rejects(() => setup.service.listDrafts(listInput()), 'BUDGET_STORAGE_UNAVAILABLE');

  assert.equal(setup.storage.state.loads, MAX_LIST_CANDIDATES);
  assert.equal(MAX_LIST_CANDIDATES, 10051);
  assert.equal(MAX_LIST_POSITIONS, 10052);
});

test('list enforces the 64 MiB declaration before loading a candidate', async () => {
  const record = await makeRecord();
  const storage = createStorage([record], { serializedBytes: [MAX_LIST_SCAN_BYTES + 1] });
  const setup = createSetup([record], { storage });

  await rejects(() => setup.service.listDrafts(listInput()), 'BUDGET_STORAGE_UNAVAILABLE');

  assert.equal(storage.state.loads, 0);
  assert.equal(MAX_LIST_SCAN_BYTES, 67108864);
});

test('list succeeds when source is exhausted and reports no more readable drafts', async () => {
  const record = await makeRecord();
  const result = await createSetup([record]).service.listDrafts(listInput({ limit: 50, offset: 10 }));
  assert.deepEqual(result, { success: true, contractVersion: 2, data: [], hasMore: false });
});

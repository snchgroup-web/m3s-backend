const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_SCAN_POSITIONS,
  MAX_STORED_DOCUMENT_BYTES,
  TARGET,
  createBudgetV2StorageAdapter
} = require('../financeBudgetV2StorageAdapter');
const { createBudgetV2WriteService } = require('../financeBudgetV2Writes');

const TENANT = 'tenant-2sg';
const ACTOR = 'user-cheikh';
const ID = '00000000-0000-4000-8000-000000000201';
const SECOND_ID = '00000000-0000-4000-8000-000000000202';
const FIRST_AT = '2026-09-09T10:00:00.000Z';
const SECOND_AT = '2026-09-10T11:30:00.000Z';

function periods() {
  const ends = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return ends.map((day, index) => {
    const month = String(index + 1).padStart(2, '0');
    return {
      periodId: `P${month}`,
      ordinal: index + 1,
      startDate: `2026-${month}-01`,
      endDate: `2026-${month}-${day}`
    };
  });
}

function snapshot(id, resolvedAt, overrides = {}) {
  return {
    id,
    labelSnapshot: `Reference ${id}`,
    statusSnapshot: 'active',
    effectiveFrom: '2025-01-01T00:00:00.000Z',
    effectiveTo: null,
    sourceRevision: 'rev-1',
    resolvedAt,
    ...overrides
  };
}

function budget(title = 'Budget 2SG 2026') {
  return {
    title,
    identity: { entityId: 'ORG-2SG', fiscalYearId: 'FY-2026' },
    responsibilities: { budgetOwnerAgentId: 'cheikh', controllerAgentId: null },
    rate: '',
    rateSource: '',
    rateDate: '',
    rows: []
  };
}

function referenceSnapshots(resolvedAt) {
  return {
    identity: {
      entityId: snapshot('ORG-2SG', resolvedAt),
      fiscalYearId: snapshot('FY-2026', resolvedAt, {
        statusSnapshot: 'open',
        entityId: 'ORG-2SG',
        summaryYear: '2026',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        periodicity: 'monthly',
        timezone: 'Europe/Zurich',
        periods: periods()
      })
    },
    responsibilities: {
      budgetOwnerAgentId: snapshot('cheikh', resolvedAt, { teamId: 'TZH' }),
      controllerAgentId: null
    },
    rows: []
  };
}

function record({ id = ID, version = 1, title = 'Budget 2SG 2026',
  createdAt = FIRST_AT, updatedAt = FIRST_AT } = {}) {
  return {
    id,
    tenantId: TENANT,
    authorUserId: ACTOR,
    version,
    title,
    entity: 'Reference ORG-2SG',
    year: '2026',
    createdAt,
    updatedAt,
    scope: 'organization',
    status: 'draft',
    access: 'owner-only',
    document: {
      contractVersion: 2,
      budget: budget(title),
      referenceSnapshots: referenceSnapshots(updatedAt)
    }
  };
}

function maximalRecord() {
  const source = record({ title: 'T'.repeat(120) });
  const entityLabel = 'E'.repeat(200);
  source.entity = entityLabel;
  source.document.referenceSnapshots.identity.entityId.labelSnapshot = entityLabel;
  const dimensions = {
    functionId: 'finance', teamId: 'TZH', agentId: 'cheikh', countryId: 'CH',
    portfolioId: 'PORT-1', dossierId: 'DOS-1', projectId: 'PROJ-1', phaseId: 'PHASE-1'
  };
  const dimensionSnapshots = {
    functionId: snapshot('finance', FIRST_AT, { labelSnapshot: 'F'.repeat(200) }),
    teamId: snapshot('TZH', FIRST_AT, { labelSnapshot: 'T'.repeat(200) }),
    agentId: structuredClone(
      source.document.referenceSnapshots.responsibilities.budgetOwnerAgentId
    ),
    countryId: snapshot('CH', FIRST_AT, { labelSnapshot: 'C'.repeat(200) }),
    portfolioId: snapshot('PORT-1', FIRST_AT, {
      labelSnapshot: 'O'.repeat(200), functionId: 'finance'
    }),
    dossierId: snapshot('DOS-1', FIRST_AT, {
      labelSnapshot: 'D'.repeat(200), portfolioId: 'PORT-1'
    }),
    projectId: snapshot('PROJ-1', FIRST_AT, {
      labelSnapshot: 'J'.repeat(200), dossierId: 'DOS-1'
    }),
    phaseId: snapshot('PHASE-1', FIRST_AT, {
      labelSnapshot: 'P'.repeat(200), statusSnapshot: 'open', projectId: 'PROJ-1'
    })
  };
  source.document.budget.rows = Array.from({ length: 100 }, (_, index) => ({
    id: `row-${String(index).padStart(3, '0')}`,
    label: 'L'.repeat(120),
    kind: 'operating',
    direction: 'out',
    currency: 'CHF',
    periodValues: periods().map(period => ({
      periodId: period.periodId, value: '1000000000'
    })),
    dimensions: { ...dimensions }
  }));
  source.document.referenceSnapshots.rows = source.document.budget.rows.map(item => ({
    rowId: item.id,
    dimensions: structuredClone(dimensionSnapshots)
  }));
  return source;
}

function row(source = record()) {
  const documentJson = JSON.stringify(source.document);
  return {
    id: source.id,
    tenant_id: source.tenantId,
    author_user_id: source.authorUserId,
    contract_version: 2,
    version: source.version,
    title: source.title,
    entity: source.entity,
    year: source.year,
    scope: source.scope,
    status: source.status,
    access: source.access,
    document_json: documentJson,
    document_bytes: Buffer.byteLength(documentJson, 'utf8'),
    created_at: source.createdAt,
    updated_at: source.updatedAt
  };
}

function contract(overrides = {}) {
  return {
    ...TARGET,
    effectiveUniqueness: true,
    atomicCreate: true,
    atomicReplace: true,
    ...overrides
  };
}

function createExecutor(options = {}) {
  const calls = [];
  const scanResults = [...(options.scanResults || [])];
  const executor = {
    calls,
    async probe(request) {
      calls.push({ method: 'probe', request });
      return options.probeResult || { available: true, contract: contract() };
    },
    async getCurrent(request) {
      calls.push({ method: 'getCurrent', request });
      return options.getResult || { available: true, rows: [row()] };
    },
    async scanCurrent(request) {
      calls.push({ method: 'scanCurrent', request });
      return scanResults.shift() || { available: true, rows: [], nextCursor: null };
    },
    async loadCurrent(request) {
      calls.push({ method: 'loadCurrent', request });
      return options.loadResult || { available: true, rows: [row()] };
    },
    async createAtomic(request) {
      calls.push({ method: 'createAtomic', request });
      if (options.createThrows) throw new Error('private create failure');
      return options.createResult || { outcome: 'created', id: ID, version: 1 };
    },
    async replaceAtomic(request) {
      calls.push({ method: 'replaceAtomic', request });
      if (options.replaceThrows) throw new Error('private replace failure');
      return options.replaceResult || { outcome: 'updated', id: ID, version: 2 };
    }
  };
  return executor;
}

async function rejects(run) {
  await assert.rejects(run, error => error?.code === 'BUDGET_STORAGE_UNAVAILABLE'
    && error.message === 'Budget V2 storage adapter failed');
}

test('probe requires all effective storage guarantees and emits an immutable plan', async () => {
  const executor = createExecutor();
  const storage = createBudgetV2StorageAdapter({ executor });
  assert.equal(Object.isFrozen(storage), true);
  assert.deepEqual(await storage.probe(), { available: true });
  assert.equal(Object.isFrozen(executor.calls[0].request), true);
  assert.equal(Object.isFrozen(executor.calls[0].request.target), true);
  for (const field of ['effectiveUniqueness', 'atomicCreate', 'atomicReplace']) {
    const broken = createExecutor({ probeResult: {
      available: true, contract: contract({ [field]: false })
    } });
    await rejects(() => createBudgetV2StorageAdapter({ executor: broken }).probe());
  }
});

test('unit read is tenant-author scoped, limited to two and maps the closed row', async () => {
  const executor = createExecutor();
  const storage = createBudgetV2StorageAdapter({ executor });
  const result = await storage.getCurrentDraft({ id: ID, tenantId: TENANT, authorUserId: ACTOR });
  assert.deepEqual(result, { available: true, records: [record()] });
  assert.deepEqual(executor.calls[0].request, {
    operation: 'getCurrent',
    target: TARGET,
    where: { id: ID, tenantId: TENANT, authorUserId: ACTOR, contractVersion: 2 },
    limit: 2
  });
});

test('unit read rejects open results, duplicates, malformed JSON and byte drift', async () => {
  await rejects(() => createBudgetV2StorageAdapter({ executor: createExecutor({
    getResult: { available: true, rows: [row(), row(), row()] }
  }) }).getCurrentDraft({ id: ID, tenantId: TENANT, authorUserId: ACTOR }));

  const malformed = row(); malformed.document_json = '{'; malformed.document_bytes = 1;
  await rejects(() => createBudgetV2StorageAdapter({ executor: createExecutor({
    getResult: { available: true, rows: [malformed] }
  }) }).getCurrentDraft({ id: ID, tenantId: TENANT, authorUserId: ACTOR }));

  const drift = row(); drift.document_bytes += 1;
  await rejects(() => createBudgetV2StorageAdapter({ executor: createExecutor({
    getResult: { available: true, rows: [drift] }
  }) }).getCurrentDraft({ id: ID, tenantId: TENANT, authorUserId: ACTOR }));
});

test('stored document size is bounded before JSON parsing', async () => {
  const oversized = row();
  oversized.document_json = 'x'.repeat(MAX_STORED_DOCUMENT_BYTES + 1);
  oversized.document_bytes = MAX_STORED_DOCUMENT_BYTES + 1;
  await rejects(() => createBudgetV2StorageAdapter({ executor: createExecutor({
    getResult: { available: true, rows: [oversized] }
  }) }).getCurrentDraft({ id: ID, tenantId: TENANT, authorUserId: ACTOR }));
});

test('the maximal bounded V2 structure remains below the four MiB envelope ceiling', async () => {
  const source = maximalRecord();
  const executor = createExecutor();
  const storage = createBudgetV2StorageAdapter({ executor });
  await storage.createCurrentDraft({
    record: source,
    audit: {
      action: 'budget_v2_draft_created', draftId: ID, version: 1, occurredAt: FIRST_AT
    }
  });
  const bytes = executor.calls[0].request.row.document_bytes;
  assert.ok(bytes > 200 * 1024);
  assert.ok(bytes < MAX_STORED_DOCUMENT_BYTES);
});

test('scan pages metadata only and loads each document lazily in the same scope', async () => {
  const second = record({ id: SECOND_ID, updatedAt: '2026-09-09T09:00:00.000Z' });
  const firstMeta = { id: ID, updated_at: FIRST_AT, document_bytes: row().document_bytes };
  const secondMeta = {
    id: SECOND_ID,
    updated_at: second.updatedAt,
    document_bytes: row(second).document_bytes
  };
  const executor = createExecutor({
    scanResults: [
      { available: true, rows: [firstMeta], nextCursor: { updatedAt: FIRST_AT, id: ID } },
      { available: true, rows: [secondMeta], nextCursor: null }
    ],
    loadResult: { available: true, rows: [row()] }
  });
  const storage = createBudgetV2StorageAdapter({ executor });
  const batches = storage.scanCurrentDrafts({
    tenantId: TENANT, authorUserId: ACTOR, batchSize: 1, maxPositions: 3
  });
  const iterator = batches[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.length, 1);
  assert.equal(executor.calls.some(call => call.method === 'loadCurrent'), false);
  assert.deepEqual(await first.value[0].load(), record());
  const next = await iterator.next();
  assert.equal(next.value[0].id, SECOND_ID);
  const scanCalls = executor.calls.filter(call => call.method === 'scanCurrent');
  assert.equal(scanCalls.length, 2);
  assert.deepEqual(scanCalls[1].request.after, { updatedAt: FIRST_AT, id: ID });
  assert.deepEqual(executor.calls.find(call => call.method === 'loadCurrent').request.where, {
    id: ID, tenantId: TENANT, authorUserId: ACTOR,
    contractVersion: 2, updatedAt: FIRST_AT
  });
});

test('scan rejects invalid bounds, order, cursors and oversized metadata', async () => {
  const storage = createBudgetV2StorageAdapter({ executor: createExecutor() });
  assert.throws(() => storage.scanCurrentDrafts({
    tenantId: TENANT, authorUserId: ACTOR, batchSize: 51, maxPositions: 1
  }), error => error?.code === 'BUDGET_STORAGE_UNAVAILABLE');
  assert.throws(() => storage.scanCurrentDrafts({
    tenantId: TENANT, authorUserId: ACTOR, batchSize: 1,
    maxPositions: MAX_SCAN_POSITIONS + 1
  }), error => error?.code === 'BUDGET_STORAGE_UNAVAILABLE');

  const badOrder = createExecutor({ scanResults: [{
    available: true,
    rows: [
      { id: SECOND_ID, updated_at: FIRST_AT, document_bytes: 10 },
      { id: ID, updated_at: FIRST_AT, document_bytes: 10 }
    ],
    nextCursor: null
  }] });
  const iterator = createBudgetV2StorageAdapter({ executor: badOrder }).scanCurrentDrafts({
    tenantId: TENANT, authorUserId: ACTOR, batchSize: 2, maxPositions: 2
  });
  await rejects(() => iterator.next());

  const badCursor = createExecutor({ scanResults: [{
    available: true,
    rows: [{ id: ID, updated_at: FIRST_AT, document_bytes: 10 }],
    nextCursor: { updatedAt: SECOND_AT, id: ID }
  }] });
  const cursorIterator = createBudgetV2StorageAdapter({ executor: badCursor }).scanCurrentDrafts({
    tenantId: TENANT, authorUserId: ACTOR, batchSize: 1, maxPositions: 2
  });
  await rejects(() => cursorIterator.next());
});

test('lazy load rejects absence, duplicates and handle drift', async () => {
  for (const loadResult of [
    { available: true, rows: [] },
    { available: true, rows: [row(), row()] },
    { available: true, rows: [row(record({ updatedAt: SECOND_AT }))] }
  ]) {
    const executor = createExecutor({
      scanResults: [{
        available: true,
        rows: [{ id: ID, updated_at: FIRST_AT, document_bytes: row().document_bytes }],
        nextCursor: null
      }],
      loadResult
    });
    const iterator = createBudgetV2StorageAdapter({ executor }).scanCurrentDrafts({
      tenantId: TENANT, authorUserId: ACTOR, batchSize: 1, maxPositions: 1
    });
    const batch = (await iterator[Symbol.asyncIterator]().next()).value;
    await rejects(() => batch[0].load());
  }
});

test('promotion remains closed without consulting the executor', async () => {
  const executor = createExecutor();
  const storage = createBudgetV2StorageAdapter({ executor });
  assert.deepEqual(await storage.findPromotionLinks({
    tenantId: TENANT, authorUserId: ACTOR, draftId: ID
  }), { available: true, records: [] });
  assert.equal(executor.calls.length, 0);
});

test('create builds one closed atomic plan and maps only allowed outcomes', async () => {
  const executor = createExecutor();
  const storage = createBudgetV2StorageAdapter({ executor });
  const source = record();
  const audit = {
    action: 'budget_v2_draft_created', draftId: ID, version: 1, occurredAt: FIRST_AT
  };
  assert.deepEqual(await storage.createCurrentDraft({ record: source, audit }), {
    outcome: 'created', id: ID, version: 1
  });
  const request = executor.calls[0].request;
  assert.equal(request.operation, 'createAtomic');
  assert.equal(request.row.document_bytes, Buffer.byteLength(request.row.document_json, 'utf8'));
  assert.deepEqual(request.audit, {
    action: audit.action,
    draft_id: ID,
    tenant_id: TENANT,
    actor_user_id: ACTOR,
    version: 1,
    occurred_at: FIRST_AT
  });
  assert.equal(Object.isFrozen(request.row), true);

  for (const outcome of ['duplicate', 'unavailable', 'uncertain']) {
    const candidate = createBudgetV2StorageAdapter({ executor: createExecutor({
      createResult: { outcome }
    }) });
    assert.deepEqual(await candidate.createCurrentDraft({ record: source, audit }), { outcome });
  }
});

test('create rejects mismatched audit, noninitial versions and contradictory outcomes', async () => {
  const source = record();
  await rejects(() => createBudgetV2StorageAdapter({ executor: createExecutor() })
    .createCurrentDraft({
      record: source,
      audit: { action: 'budget_v2_draft_created', draftId: ID, version: 2, occurredAt: FIRST_AT }
    }));
  await rejects(() => createBudgetV2StorageAdapter({ executor: createExecutor() })
    .createCurrentDraft({
      record: record({ version: 2 }),
      audit: { action: 'budget_v2_draft_created', draftId: ID, version: 2, occurredAt: FIRST_AT }
    }));
  await rejects(() => createBudgetV2StorageAdapter({ executor: createExecutor({
    createResult: { outcome: 'conflict' }
  }) }).createCurrentDraft({
    record: source,
    audit: { action: 'budget_v2_draft_created', draftId: ID, version: 1, occurredAt: FIRST_AT }
  }));
  await rejects(() => createBudgetV2StorageAdapter({ executor: createExecutor({
    createResult: { outcome: 'created', id: SECOND_ID, version: 1 }
  }) }).createCurrentDraft({
    record: source,
    audit: { action: 'budget_v2_draft_created', draftId: ID, version: 1, occurredAt: FIRST_AT }
  }));
});

test('replace binds identity and expected version into one immutable atomic plan', async () => {
  const next = record({ version: 2, updatedAt: SECOND_AT });
  const audit = {
    action: 'budget_v2_draft_updated', draftId: ID, version: 2, occurredAt: SECOND_AT
  };
  const executor = createExecutor();
  const storage = createBudgetV2StorageAdapter({ executor });
  assert.deepEqual(await storage.replaceCurrentDraft({
    id: ID, tenantId: TENANT, authorUserId: ACTOR,
    expectedVersion: 1, nextRecord: next, audit
  }), { outcome: 'updated', id: ID, version: 2 });
  assert.deepEqual(executor.calls[0].request.where, {
    id: ID, tenantId: TENANT, authorUserId: ACTOR,
    contractVersion: 2, expectedVersion: 1
  });
  assert.equal(Object.isFrozen(executor.calls[0].request), true);

  for (const outcome of ['missing', 'conflict', 'duplicate', 'unavailable', 'uncertain']) {
    const candidate = createBudgetV2StorageAdapter({ executor: createExecutor({
      replaceResult: { outcome }
    }) });
    assert.deepEqual(await candidate.replaceCurrentDraft({
      id: ID, tenantId: TENANT, authorUserId: ACTOR,
      expectedVersion: 1, nextRecord: next, audit
    }), { outcome });
  }
});

test('replace rejects identity, version and audit drift before the executor', async () => {
  const next = record({ version: 2, updatedAt: SECOND_AT });
  const valid = {
    id: ID, tenantId: TENANT, authorUserId: ACTOR, expectedVersion: 1,
    nextRecord: next,
    audit: { action: 'budget_v2_draft_updated', draftId: ID, version: 2, occurredAt: SECOND_AT }
  };
  for (const mutate of [
    value => { value.expectedVersion = 2; },
    value => { value.authorUserId = 'other-user'; },
    value => { value.audit.occurredAt = FIRST_AT; },
    value => { value.nextRecord.id = SECOND_ID; }
  ]) {
    const input = structuredClone(valid); mutate(input);
    const executor = createExecutor();
    await rejects(() => createBudgetV2StorageAdapter({ executor }).replaceCurrentDraft(input));
    assert.equal(executor.calls.length, 0);
  }
});

test('executor failures are sanitized and write services retain uncertain semantics', async () => {
  const storage = createBudgetV2StorageAdapter({ executor: createExecutor({ createThrows: true }) });
  const service = createBudgetV2WriteService({
    storage,
    referenceServiceFactory: context => ({
      async resolveBudgetReferences() { return referenceSnapshots(context.writeAt.toISOString()); }
    }),
    clock: () => new Date(FIRST_AT),
    uuidGenerator: () => ID
  });
  await assert.rejects(() => service.createDraft({
    tenantId: TENANT,
    actorId: ACTOR,
    v2Enabled: true,
    financeRead: true,
    financeWrite: true,
    body: { contractVersion: 2, budget: budget() }
  }), error => error?.code === 'BUDGET_WRITE_UNCERTAIN'
    && error.draftId === ID && error.reconcileRequired === true
    && !error.message.includes('private'));
});

test('pure adapter contains no route, cloud SDK, environment or DDL dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'financeBudgetV2StorageAdapter.js'), 'utf8');
  for (const forbidden of [
    /\bexpress\b/i,
    /@google-cloud/i,
    /process\.env/,
    /CREATE\s+TABLE/i,
    /ALTER\s+TABLE/i,
    /DROP\s+TABLE/i,
    /require\(['"](?:pg|mysql|sqlite|@electric-sql)/i
  ]) assert.doesNotMatch(source, forbidden);
});

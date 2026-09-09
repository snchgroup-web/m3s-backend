const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const {
  createBudgetV2PostgresStorageExecutor
} = require('../financeBudgetV2PostgresStorageExecutor');
const {
  createBudgetV2PGliteEphemeralSession
} = require('../financeBudgetV2PostgresEphemeralExecutor');
const {
  buildBudgetV2PostgresOfflinePlan,
  SCHEMA_NAME
} = require('../financeBudgetV2PostgresSchema');
const {
  MAX_STORED_DOCUMENT_BYTES,
  TARGET,
  createBudgetV2StorageAdapter
} = require('../financeBudgetV2StorageAdapter');

const TENANT_A = 'tenant-synthetic-a';
const TENANT_B = 'tenant-synthetic-b';
const ACTOR_A = 'actor-synthetic-a';
const ACTOR_B = 'actor-synthetic-b';
const ID_A = '10000000-0000-4000-8000-000000000001';
const ID_B = '10000000-0000-4000-8000-000000000002';
const ID_C = '10000000-0000-4000-8000-000000000003';
const FIRST_AT = '2026-09-10T00:00:00.000Z';
const SECOND_AT = '2026-09-10T00:01:00.000Z';

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
    labelSnapshot: `Synthetic ${id}`,
    statusSnapshot: 'active',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    sourceRevision: 'synthetic-rev-1',
    resolvedAt,
    ...overrides
  };
}

function document(resolvedAt, title = 'Synthetic Budget 2026') {
  return {
    contractVersion: 2,
    budget: {
      title,
      identity: { entityId: 'ORG-SYNTHETIC', fiscalYearId: 'FY-SYNTHETIC-2026' },
      responsibilities: { budgetOwnerAgentId: 'actor-synthetic-a', controllerAgentId: null },
      rate: '',
      rateSource: '',
      rateDate: '',
      rows: []
    },
    referenceSnapshots: {
      identity: {
        entityId: snapshot('ORG-SYNTHETIC', resolvedAt, {
          labelSnapshot: 'Synthetic Organization'
        }),
        fiscalYearId: snapshot('FY-SYNTHETIC-2026', resolvedAt, {
          statusSnapshot: 'open',
          entityId: 'ORG-SYNTHETIC',
          summaryYear: '2026',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          periodicity: 'monthly',
          timezone: 'Europe/Zurich',
          periods: periods()
        })
      },
      responsibilities: {
        budgetOwnerAgentId: snapshot('actor-synthetic-a', resolvedAt, {
          teamId: 'TEAM-SYNTHETIC'
        }),
        controllerAgentId: null
      },
      rows: []
    }
  };
}

function record({
  id = ID_A,
  tenantId = TENANT_A,
  authorUserId = ACTOR_A,
  version = 1,
  title = 'Synthetic Budget 2026',
  createdAt = FIRST_AT,
  updatedAt = FIRST_AT
} = {}) {
  const value = document(updatedAt, title);
  value.budget.responsibilities.budgetOwnerAgentId = authorUserId;
  value.referenceSnapshots.responsibilities.budgetOwnerAgentId.id = authorUserId;
  value.referenceSnapshots.responsibilities.budgetOwnerAgentId.labelSnapshot = `Synthetic ${authorUserId}`;
  return {
    id,
    tenantId,
    authorUserId,
    version,
    title,
    entity: 'Synthetic Organization',
    year: '2026',
    createdAt,
    updatedAt,
    scope: 'organization',
    status: 'draft',
    access: 'owner-only',
    document: value
  };
}

function audit(source, action = 'budget_v2_draft_created') {
  return {
    action,
    draftId: source.id,
    version: source.version,
    occurredAt: source.updatedAt
  };
}

async function harness() {
  const database = new PGlite();
  await database.exec(`CREATE SCHEMA ${SCHEMA_NAME}`);
  for (const statement of buildBudgetV2PostgresOfflinePlan().statements) {
    await database.exec(statement);
  }
  const session = createBudgetV2PGliteEphemeralSession(database);
  const executor = createBudgetV2PostgresStorageExecutor({ session });
  return {
    database,
    session,
    executor,
    storage: createBudgetV2StorageAdapter({ executor }),
    close: () => database.close()
  };
}

function wrappedSession(base, overrides = {}) {
  return {
    capabilities: base.capabilities,
    query: overrides.query || ((text, params) => base.query(text, params)),
    transaction: overrides.transaction || (callback => base.transaction(callback))
  };
}

async function insert(storage, source) {
  return storage.createCurrentDraft({ record: source, audit: audit(source) });
}

async function replace(storage, source, expectedVersion = 1) {
  return storage.replaceCurrentDraft({
    id: source.id,
    tenantId: source.tenantId,
    authorUserId: source.authorUserId,
    expectedVersion,
    nextRecord: source,
    audit: audit(source, 'budget_v2_draft_updated')
  });
}

async function counts(database) {
  const current = await database.query(
    `SELECT count(*)::integer AS count FROM ${SCHEMA_NAME}.finance_budget_drafts_v2_current`
  );
  const events = await database.query(
    `SELECT count(*)::integer AS count FROM ${SCHEMA_NAME}.finance_budget_draft_events_v2`
  );
  return { current: current.rows[0].count, events: events.rows[0].count };
}

function rawRow(json, overrides = {}) {
  return {
    id: ID_A,
    tenant_id: TENANT_A,
    author_user_id: ACTOR_A,
    contract_version: 2,
    version: 1,
    title: 'Synthetic Budget 2026',
    entity: 'Synthetic Organization',
    year: '2026',
    scope: 'organization',
    status: 'draft',
    access: 'owner-only',
    document_json: json,
    document_bytes: Buffer.byteLength(json, 'utf8'),
    created_at: FIRST_AT,
    updated_at: FIRST_AT,
    ...overrides
  };
}

function rawAudit(row, action = 'budget_v2_draft_created') {
  return {
    action,
    draft_id: row.id,
    tenant_id: row.tenant_id,
    actor_user_id: row.author_user_id,
    version: row.version,
    occurred_at: row.updated_at
  };
}

function createRequest(row) {
  return { operation: 'createAtomic', target: TARGET, row, audit: rawAudit(row) };
}

test('01 probe confirms the effective isolated storage guarantees', async () => {
  const local = await harness();
  try {
    assert.deepEqual(await local.storage.probe(), { available: true });
  } finally {
    await local.close();
  }
});

test('02 concurrent creations produce one created and one duplicate', async () => {
  const local = await harness();
  try {
    const source = record();
    const results = await Promise.all([insert(local.storage, source), insert(local.storage, source)]);
    assert.deepEqual(results.map(item => item.outcome).sort(), ['created', 'duplicate']);
  } finally {
    await local.close();
  }
});

test('03 concurrent replacements produce one updated and one conflict', async () => {
  const local = await harness();
  try {
    await insert(local.storage, record());
    const next = record({ version: 2, updatedAt: SECOND_AT });
    const results = await Promise.all([
      replace(local.storage, next), replace(local.storage, structuredClone(next))
    ]);
    assert.deepEqual(results.map(item => item.outcome).sort(), ['conflict', 'updated']);
  } finally {
    await local.close();
  }
});

test('04 a concurrent replacement increments the stored version once', async () => {
  const local = await harness();
  try {
    await insert(local.storage, record());
    const next = record({ version: 2, updatedAt: SECOND_AT });
    await Promise.all([replace(local.storage, next), replace(local.storage, next)]);
    const result = await local.database.query(
      `SELECT version FROM ${SCHEMA_NAME}.finance_budget_drafts_v2_current`
    );
    assert.deepEqual(result.rows, [{ version: 2 }]);
  } finally {
    await local.close();
  }
});

test('05 a losing replacement creates no additional audit event', async () => {
  const local = await harness();
  try {
    await insert(local.storage, record());
    const next = record({ version: 2, updatedAt: SECOND_AT });
    await Promise.all([replace(local.storage, next), replace(local.storage, next)]);
    assert.deepEqual(await counts(local.database), { current: 1, events: 2 });
  } finally {
    await local.close();
  }
});

test('06 failure before audit insertion rolls back the current draft', async () => {
  const local = await harness();
  try {
    const session = wrappedSession(local.session, {
      transaction: callback => local.session.transaction(transaction => callback({
        ...transaction,
        query: (text, params) => {
          if (text.includes('finance_budget_draft_events_v2')) {
            throw new Error('synthetic audit refusal');
          }
          return transaction.query(text, params);
        }
      }))
    });
    const storage = createBudgetV2StorageAdapter({
      executor: createBudgetV2PostgresStorageExecutor({ session })
    });
    assert.equal((await insert(storage, record())).outcome, 'unavailable');
    assert.deepEqual(await counts(local.database), { current: 0, events: 0 });
  } finally {
    await local.close();
  }
});

test('07 failure after audit execution but before commit rolls back both rows', async () => {
  const local = await harness();
  try {
    const session = wrappedSession(local.session, {
      transaction: callback => local.session.transaction(transaction => callback({
        ...transaction,
        query: async (text, params) => {
          const result = await transaction.query(text, params);
          if (text.includes('finance_budget_draft_events_v2')) {
            throw new Error('synthetic precommit refusal');
          }
          return result;
        }
      }))
    });
    const storage = createBudgetV2StorageAdapter({
      executor: createBudgetV2PostgresStorageExecutor({ session })
    });
    assert.equal((await insert(storage, record())).outcome, 'unavailable');
    assert.deepEqual(await counts(local.database), { current: 0, events: 0 });
  } finally {
    await local.close();
  }
});

test('08 the foreign key rejects an audit without a current draft', async () => {
  const local = await harness();
  try {
    await assert.rejects(() => local.database.query(
      `INSERT INTO ${SCHEMA_NAME}.finance_budget_draft_events_v2
       (tenant_id, actor_user_id, draft_id, version, action, occurred_at)
       VALUES ($1, $2, $3, 1, 'budget_v2_draft_created', $4)`,
      [TENANT_A, ACTOR_A, ID_A, FIRST_AT]
    ), error => error?.code === '23503');
    assert.deepEqual(await counts(local.database), { current: 0, events: 0 });
  } finally {
    await local.close();
  }
});

test('09 identical author and id remain isolated between tenants', async () => {
  const local = await harness();
  try {
    await insert(local.storage, record());
    await insert(local.storage, record({ tenantId: TENANT_B }));
    const first = await local.storage.getCurrentDraft({
      id: ID_A, tenantId: TENANT_A, authorUserId: ACTOR_A
    });
    const second = await local.storage.getCurrentDraft({
      id: ID_A, tenantId: TENANT_B, authorUserId: ACTOR_A
    });
    assert.equal(first.records[0].tenantId, TENANT_A);
    assert.equal(second.records[0].tenantId, TENANT_B);
  } finally {
    await local.close();
  }
});

test('10 identical tenant and id remain isolated between authors', async () => {
  const local = await harness();
  try {
    await insert(local.storage, record());
    await insert(local.storage, record({ authorUserId: ACTOR_B }));
    const first = await local.storage.getCurrentDraft({
      id: ID_A, tenantId: TENANT_A, authorUserId: ACTOR_A
    });
    const second = await local.storage.getCurrentDraft({
      id: ID_A, tenantId: TENANT_A, authorUserId: ACTOR_B
    });
    assert.equal(first.records[0].authorUserId, ACTOR_A);
    assert.equal(second.records[0].authorUserId, ACTOR_B);
  } finally {
    await local.close();
  }
});

test('11 read list load and replace outside the scope reveal no draft', async () => {
  const local = await harness();
  try {
    await insert(local.storage, record());
    assert.deepEqual(await local.storage.getCurrentDraft({
      id: ID_A, tenantId: TENANT_B, authorUserId: ACTOR_A
    }), { available: true, records: [] });
    const iterator = local.storage.scanCurrentDrafts({
      tenantId: TENANT_B, authorUserId: ACTOR_A, batchSize: 10, maxPositions: 10
    });
    assert.equal((await iterator[Symbol.asyncIterator]().next()).done, true);
    const next = record({ tenantId: TENANT_B, version: 2, updatedAt: SECOND_AT });
    assert.deepEqual(await replace(local.storage, next), { outcome: 'missing' });
    const load = await local.executor.loadCurrent({
      operation: 'loadCurrent',
      target: TARGET,
      where: {
        id: ID_A, tenantId: TENANT_B, authorUserId: ACTOR_A,
        contractVersion: 2, updatedAt: FIRST_AT
      },
      limit: 2
    });
    assert.deepEqual(load, { available: true, rows: [] });
  } finally {
    await local.close();
  }
});

test('12 audit rows retain the tenant and actor of each mutation', async () => {
  const local = await harness();
  try {
    await insert(local.storage, record());
    await replace(local.storage, record({ version: 2, updatedAt: SECOND_AT }));
    const result = await local.database.query(
      `SELECT tenant_id, actor_user_id, draft_id, version
       FROM ${SCHEMA_NAME}.finance_budget_draft_events_v2 ORDER BY version`
    );
    assert.deepEqual(result.rows, [
      { tenant_id: TENANT_A, actor_user_id: ACTOR_A, draft_id: ID_A, version: 1 },
      { tenant_id: TENANT_A, actor_user_id: ACTOR_A, draft_id: ID_A, version: 2 }
    ]);
    const current = await local.database.query(
      `SELECT created_at FROM ${SCHEMA_NAME}.finance_budget_drafts_v2_current`
    );
    assert.equal(current.rows[0].created_at.toISOString(), FIRST_AT);
  } finally {
    await local.close();
  }
});

test('13 malformed JSON bytes domains and chronology are rejected before storage', async () => {
  const local = await harness();
  try {
    const candidates = [
      rawRow('{'),
      rawRow('{}', { document_bytes: 9 }),
      rawRow('{}', { scope: 'personal' }),
      rawRow('{}', { created_at: SECOND_AT, updated_at: FIRST_AT })
    ];
    for (const candidate of candidates) {
      await assert.rejects(
        () => local.executor.createAtomic(createRequest(candidate)),
        error => error?.code === 'BUDGET_V2_POSTGRES_STORAGE_UNAVAILABLE'
      );
    }
    assert.deepEqual(await counts(local.database), { current: 0, events: 0 });
  } finally {
    await local.close();
  }
});

test('14 the four MiB document boundary is enforced without truncation', async () => {
  const local = await harness();
  try {
    const overhead = Buffer.byteLength('{"padding":""}', 'utf8');
    const json = JSON.stringify({ padding: 'x'.repeat(MAX_STORED_DOCUMENT_BYTES - overhead) });
    const accepted = rawRow(json);
    assert.equal(accepted.document_bytes, MAX_STORED_DOCUMENT_BYTES);
    assert.equal((await local.executor.createAtomic(createRequest(accepted))).outcome, 'created');
    const oversizedJson = `${json} `;
    const oversized = rawRow(oversizedJson, { id: ID_B });
    await assert.rejects(
      () => local.executor.createAtomic(createRequest(oversized)),
      error => error?.code === 'BUDGET_V2_POSTGRES_STORAGE_UNAVAILABLE'
    );
  } finally {
    await local.close();
  }
});

test('15 pagination is stable when timestamps are equal', async () => {
  const local = await harness();
  try {
    for (const id of [ID_C, ID_A, ID_B]) await insert(local.storage, record({ id }));
    const seen = [];
    for await (const batch of local.storage.scanCurrentDrafts({
      tenantId: TENANT_A, authorUserId: ACTOR_A, batchSize: 2, maxPositions: 10
    })) seen.push(...batch.map(item => item.id));
    assert.deepEqual(seen, [ID_A, ID_B, ID_C]);
  } finally {
    await local.close();
  }
});

test('16 list scans metadata only and load remains lazy', async () => {
  const local = await harness();
  try {
    await insert(local.storage, record());
    const queries = [];
    const session = wrappedSession(local.session, {
      query: (text, params) => {
        queries.push(text);
        return local.session.query(text, params);
      }
    });
    const storage = createBudgetV2StorageAdapter({
      executor: createBudgetV2PostgresStorageExecutor({ session })
    });
    const iterator = storage.scanCurrentDrafts({
      tenantId: TENANT_A, authorUserId: ACTOR_A, batchSize: 1, maxPositions: 1
    });
    const batch = (await iterator[Symbol.asyncIterator]().next()).value;
    assert.equal(queries.length, 1);
    assert.doesNotMatch(queries[0], /document_json/i);
    await batch[0].load();
    assert.match(queries[1], /document_json/i);
  } finally {
    await local.close();
  }
});

test('17 an invalid request is rejected before opening a transaction', async () => {
  const local = await harness();
  try {
    let transactions = 0;
    const session = wrappedSession(local.session, {
      transaction: callback => {
        transactions += 1;
        return local.session.transaction(callback);
      }
    });
    const executor = createBudgetV2PostgresStorageExecutor({ session });
    const row = rawRow('{}');
    await assert.rejects(() => executor.createAtomic({
      ...createRequest(row),
      target: { ...TARGET, currentStore: 'unexpected' }
    }), error => error?.code === 'BUDGET_V2_POSTGRES_STORAGE_UNAVAILABLE');
    assert.equal(transactions, 0);
    const openSession = wrappedSession(local.session, {
      transaction: callback => local.session.transaction(transaction => callback({
        ...transaction,
        capabilities: { ...transaction.capabilities, networkMode: 'loopback' }
      }))
    });
    const guarded = createBudgetV2PostgresStorageExecutor({ session: openSession });
    assert.deepEqual(await guarded.createAtomic(createRequest(row)), {
      outcome: 'unavailable'
    });
    assert.deepEqual(await counts(local.database), { current: 0, events: 0 });
  } finally {
    await local.close();
  }
});

test('18 a certain transaction failure is sanitized and fully rolled back', async () => {
  const local = await harness();
  try {
    const privateValue = 'synthetic-private-document-value';
    const session = wrappedSession(local.session, {
      transaction: callback => local.session.transaction(transaction => callback({
        ...transaction,
        query: (text, params) => {
          if (text.includes('finance_budget_draft_events_v2')) {
            throw new Error(privateValue);
          }
          return transaction.query(text, params);
        }
      }))
    });
    const executor = createBudgetV2PostgresStorageExecutor({ session });
    const result = await executor.createAtomic(createRequest(rawRow(JSON.stringify({ privateValue }))));
    assert.deepEqual(result, { outcome: 'unavailable' });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue));
    assert.deepEqual(await counts(local.database), { current: 0, events: 0 });
  } finally {
    await local.close();
  }
});

test('19 a lost commit acknowledgement is uncertain and is never retried', async () => {
  const local = await harness();
  try {
    let transactions = 0;
    const session = wrappedSession(local.session, {
      transaction: async callback => {
        transactions += 1;
        await local.session.transaction(callback);
        throw new Error('synthetic lost acknowledgement');
      }
    });
    const executor = createBudgetV2PostgresStorageExecutor({ session });
    assert.deepEqual(await executor.createAtomic(createRequest(rawRow('{}'))), {
      outcome: 'uncertain'
    });
    assert.equal(transactions, 1);
    assert.deepEqual(await counts(local.database), { current: 1, events: 1 });
  } finally {
    await local.close();
  }
});

test('20 executor source has no client route environment DDL or real-data dependency', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'financeBudgetV2PostgresStorageExecutor.js'), 'utf8'
  );
  for (const forbidden of [
    /require\(['"]@electric-sql\/pglite/i,
    /\bexpress\b/i,
    /process\.env/,
    /CREATE\s+(?:SCHEMA|TABLE|INDEX)/i,
    /ALTER\s+TABLE/i,
    /DROP\s+(?:SCHEMA|TABLE)/i,
    /server\.js/i,
    /tenant-2sg|user-cheikh/i
  ]) assert.doesNotMatch(source, forbidden);
});

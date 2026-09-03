const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, createBudgetTestQueryClient, runCloud, main } = require('../scripts/testBudgetCloud');

const args = ['--project', 'test-project', '--dataset', 'm3s_budget_test_acceptance', '--location', 'EU'];
const execution = [...args, '--execute', '--confirm', 'test-project.m3s_budget_test_acceptance'];
const config = parseArgs(execution);
const metadata = () => ({ datasetReference: { projectId: config.projectId, datasetId: config.datasetId },
  location: 'EU', labels: { purpose: 'm3s_budget_test' }, defaultTableExpirationMs: '86400000' });

function fixture(change = {}) {
  const calls = []; const rows = new Map(); const events = []; let metadataCalls = 0;
  const client = {
    dataset(id) {
      assert.equal(id, config.datasetId);
      return { async getMetadata() { metadataCalls++; if (change.metadataError) throw new Error('PRIVATE KEY AND SQL');
        return [change.metadata || metadata()]; },
      async getTables(options) { assert.deepEqual(options, { maxResults: 1, autoPaginate: false });
        return [change.tables || [], change.next || null]; } };
    },
    async query(options) {
      calls.push(options);
      if (change.queryError) throw new Error('PRIVATE KEY AND SQL');
      const q = options.query; const p = options.params;
      if (q.startsWith('CREATE TABLE')) return [[]];
      if (q.includes('ASSERT FALSE')) throw new Error('Synthetic failed transaction');
      if (q.startsWith('BEGIN TRANSACTION')) {
        rows.set(p.id, { id: p.id, version: 1, title: p.title, entity: p.entity, year: p.year,
          budget_json: p.budgetJson, tenant_id: p.tenantId, owner_user_id: p.ownerId,
          created_at: { value: '2026-01-01T00:00:00Z' }, updated_at: { value: '2026-01-01T00:00:00Z' } });
        events.push({ draft_id: p.id, version: 1, action: 'created' });
        return [[{ outcome: 'saved', version: 1 }]];
      }
      const scoped = [...rows.values()].filter(row => row.tenant_id === p?.tenantId && row.owner_user_id === p?.ownerId);
      if (q.startsWith('DECLARE outcome')) {
        const row = scoped.find(row => row.id === p.id);
        if (!row) return [[{ outcome: 'missing' }]];
        if (row.version !== p.expectedVersion) return [[{ outcome: 'conflict' }]];
        Object.assign(row, { version: p.nextVersion, title: p.title, entity: p.entity, year: p.year, budget_json: p.budgetJson });
        events.push({ draft_id: p.id, version: p.nextVersion, action: 'updated' });
        return [[{ outcome: 'saved', version: p.nextVersion }]];
      }
      if (q.startsWith('SELECT version, action')) return [events.filter(e => e.draft_id === p.id)];
      if (q.includes('AS drafts')) return [[{ drafts: rows.size, events: events.length + (change.badAudit ? 1 : 0) }]];
      if (q.includes('AND id = @id')) return [scoped.filter(row => row.id === p.id).map(row => ({ ...row }))];
      if (q.includes('ORDER BY updated_at')) return [scoped.slice(p.offset, p.offset + p.limit)];
      throw new Error('Unrecognized test query');
    }
  };
  return { client, calls, rows, events, get metadataCalls() { return metadataCalls; } };
}

test('plan never initializes Google SDK or reads cloud metadata, even with an explicit target', async () => {
  for (const planArgs of [[], ['--plan'], args, [...args, '--plan']]) {
    const logs = [];
    assert.equal(await main(planArgs, { env: {}, log: value => logs.push(value),
      createClient() { assert.fail('Plan attempted cloud access'); } }), 0);
    assert.equal(logs[0].mode, 'plan'); assert.equal(logs[0].cloudAccess, false);
    assert.equal(logs[0].executionAuthorized, false); assert.equal(logs[0].checks.length, 10);
  }
});

const invalidArgs = {
  noTarget: ['--execute'], missingConfirmation: [...args, '--execute'], wrongConfirmation: [...args, '--execute', '--confirm', 'other'],
  productionName: ['--project', 'test-project', '--dataset', 'm3s_production', '--location', 'EU', '--execute'],
  injection: ['--project', 'test-project', '--dataset', 'm3s_budget_test_x`', '--location', 'EU'],
  incomplete: ['--project', 'test-project'], unknown: [...args, '--force'], duplicate: [...args, '--project', 'test-project'],
  twoModes: [...execution, '--plan'], missingValue: ['--project', '--execute'], confirmOnly: [...args, '--confirm', 'x']
};
for (const [name, input] of Object.entries(invalidArgs)) test(`CLI refuses ${name} before any Google client`, async () => {
  assert.equal(await main(input, { env: {}, log() {}, createClient() { assert.fail('Unsafe client'); } }), 1);
});

test('known application dataset is refused despite test naming', () => {
  assert.throws(() => parseArgs(execution, { BIGQUERY_PROJECT: config.projectId, BIGQUERY_DATASET: config.datasetId }),
    /APPLICATION_DATASET_FORBIDDEN/);
});

test('direct runner refuses non-execution mode before metadata', async () => {
  const fake = fixture(); await assert.rejects(runCloud({ ...config, execute: false }, fake.client), /EXECUTION_REQUIRED/);
  assert.equal(fake.metadataCalls, 0);
});

test('original target confirmation is retained and required at the direct execution boundary', async () => {
  assert.equal(config.confirmation, 'test-project.m3s_budget_test_acceptance');
  for (const confirmation of [undefined, '', 'other-project.m3s_budget_test_acceptance']) {
    const fake = fixture();
    await assert.rejects(runCloud({ ...config, confirmation }, fake.client),
      /MISSING_ARGUMENT_VALUE|EXACT_TARGET_CONFIRMATION_REQUIRED/);
    assert.equal(fake.metadataCalls, 0); assert.equal(fake.calls.length, 0);
  }
});

test('changing the target after confirmation or using the application dataset prevents direct execution', async () => {
  const fake = fixture();
  await assert.rejects(runCloud({ ...config, datasetId: 'm3s_budget_test_other' }, fake.client),
    /EXACT_TARGET_CONFIRMATION_REQUIRED/);
  await assert.rejects(runCloud(config, fake.client, { env: { BIGQUERY_PROJECT: config.projectId,
    BIGQUERY_DATASET: config.datasetId } }), /APPLICATION_DATASET_FORBIDDEN/);
  assert.equal(fake.metadataCalls, 0); assert.equal(fake.calls.length, 0);
});

test('query limit counts exactly forty client submissions, never the rejected forty-first', async () => {
  let submissions = 0;
  const report = { queries: 0, runId: 'count-test' };
  const client = createBudgetTestQueryClient({ async query() { submissions++; return [[]]; } }, config, report);
  for (let i = 0; i < 40; i++) await client.query({ query: 'SELECT 1' });
  for (let i = 0; i < 2; i++) await assert.rejects(client.query({ query: 'SELECT 1' }), /QUERY_LIMIT_REACHED/);
  assert.equal(submissions, 40); assert.equal(report.queries, 40);
});

test('a failed client submission remains counted and is not retried', async () => {
  let submissions = 0;
  const report = { queries: 0, runId: 'failed-test' };
  const client = createBudgetTestQueryClient({ async query() { submissions++; throw new Error('Unavailable'); } }, config, report);
  await assert.rejects(client.query({ query: 'SELECT 1' }), /Unavailable/);
  assert.equal(submissions, 1); assert.equal(report.queries, 1);
});

const invalidMetadata = {
  project: m => { m.datasetReference.projectId = 'other'; }, dataset: m => { m.datasetReference.datasetId = 'other'; },
  location: m => { m.location = 'US'; }, label: m => { m.labels.purpose = 'production'; },
  noLabel: m => { delete m.labels; }, noExpiry: m => { delete m.defaultTableExpirationMs; },
  infiniteExpiry: m => { m.defaultTableExpirationMs = 'Infinity'; }, tooLong: m => { m.defaultTableExpirationMs = '604800001'; },
  tooShort: m => { m.defaultTableExpirationMs = '1'; }
};
for (const [name, mutate] of Object.entries(invalidMetadata)) test(`dataset guard refuses ${name} before SQL`, async () => {
  const m = metadata(); mutate(m); const fake = fixture({ metadata: m });
  const report = await runCloud(config, fake.client); assert.equal(report.status, 'failed');
  assert.equal(report.stage, 'dataset-guard'); assert.equal(fake.calls.length, 0);
});

test('nonempty or incompletely enumerated datasets are never modified', async () => {
  for (const change of [{ tables: [{ id: 'real_table' }] }, { next: { pageToken: 'more' } }]) {
    const fake = fixture(change); const report = await runCloud(config, fake.client);
    assert.equal(report.reason, 'EMPTY_DEDICATED_DATASET_REQUIRED'); assert.equal(fake.calls.length, 0);
  }
});

test('all ten recipe checks run on a double, with no production startup or deletion', async () => {
  const fake = fixture(); const passed = [];
  const report = await runCloud(config, fake.client, { log: row => passed.push(row.passed) });
  assert.equal(report.status, 'passed', JSON.stringify(report)); assert.equal(passed.length, 10);
  assert.deepEqual(passed, report.checks); assert.equal(report.queries, fake.calls.length);
  assert.equal(report.queries, 25); assert.equal(fake.rows.size, 4); assert.equal(fake.events.length, 6);
  for (const options of fake.calls) {
    assert.equal(options.location, 'EU'); assert.equal(options.maximumBytesBilled, '67108864');
    assert.equal(options.jobTimeoutMs, 60000); assert.equal(options.useQueryCache, false);
    assert.equal(options.useLegacySql, false); assert.equal(options.labels.purpose, 'm3s_budget_test');
    assert.doesNotMatch(options.query, /\b(?:DELETE|DROP|TRUNCATE|GRANT)\b/);
    for (const match of options.query.matchAll(/`([^`]+)`/g)) assert(match[1].startsWith(`${config.projectId}.${config.datasetId}.`));
  }
});

test('failed cloud metadata or SQL emits a safe stage, no private exception', async () => {
  for (const [change, stage] of [[{ metadataError: true }, 'dataset-guard'], [{ queryError: true }, 'schema']]) {
    const fake = fixture(change); const logs = [];
    const code = await main(execution, { env: {}, createClient: () => fake.client, log: v => logs.push(v) });
    assert.equal(code, 1); assert.equal(logs.at(-1).stage, stage);
    assert.equal(logs.at(-1).status, 'failed'); assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|KEY|SQL/);
  }
});

test('audit mismatch cannot produce a passed recipe', async () => {
  const report = await runCloud(config, fixture({ badAudit: true }).client);
  assert.equal(report.status, 'failed'); assert.equal(report.stage, 'audit'); assert.equal(report.checks.length, 9);
});

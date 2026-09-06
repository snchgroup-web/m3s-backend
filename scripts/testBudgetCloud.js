const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildBudgetSchemaStatements, createBudgetDraftHandlers } = require('../financeBudgetDrafts');

const MAX_QUERIES = 40;
const MAX_BYTES = '67108864';
const MIN_NEW_TEST_TABLE_EXPIRATION_MS = 2 * 60 * 60 * 1000;
const MAX_TEST_TABLE_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const checks = ['schema', 'round-trip', 'read-only', 'owner-isolation', 'tenant-isolation',
  'stale-version', 'competing-writers', 'atomic-rollback', 'uncertain-response', 'audit'];
const refusal = code => { const error = new Error(code); error.safeCode = code; throw error; };

function parseArgs(args, env = {}) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--plan', '--execute', '--project', '--dataset', '--location', '--confirm'].includes(key)
      || Object.hasOwn(flags, key)) refusal('INVALID_ARGUMENTS');
    if (key === '--plan' || key === '--execute') flags[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) refusal('MISSING_ARGUMENT_VALUE');
      flags[key] = value;
    }
  }
  if (flags['--plan'] && flags['--execute']) refusal('CONFLICTING_MODES');
  const config = { execute: flags['--execute'] === true, projectId: flags['--project'],
    datasetId: flags['--dataset'], location: flags['--location'], confirmation: flags['--confirm'] };
  const hasTarget = config.projectId || config.datasetId || config.location;
  if (hasTarget || config.execute) {
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.projectId || '')
      || !/^m3s_budget_test_[a-z0-9_]{1,60}$/.test(config.datasetId || '')
      || !/^(US|EU|[a-z]+(?:-[a-z0-9]+)+)$/.test(config.location || '')) refusal('INVALID_TEST_TARGET');
    if (config.projectId === env.BIGQUERY_PROJECT && config.datasetId === env.BIGQUERY_DATASET) {
      refusal('APPLICATION_DATASET_FORBIDDEN');
    }
  }
  if (config.execute && flags['--confirm'] !== `${config.projectId}.${config.datasetId}`) {
    refusal('EXACT_TARGET_CONFIRMATION_REQUIRED');
  }
  if (!config.execute && flags['--confirm']) refusal('CONFIRM_REQUIRES_EXECUTE');
  return config;
}

function assertTestDataset(metadata, config) {
  if (metadata?.datasetReference?.projectId !== config.projectId
    || metadata?.datasetReference?.datasetId !== config.datasetId
    || metadata?.location?.toLowerCase() !== config.location.toLowerCase()
    || metadata?.labels?.purpose !== 'm3s_budget_test') refusal('DATASET_NOT_APPROVED_FOR_TEST');
  const expiration = Number(metadata.defaultTableExpirationMs);
  if (!Number.isFinite(expiration) || expiration < MIN_NEW_TEST_TABLE_EXPIRATION_MS
    || expiration > MAX_TEST_TABLE_EXPIRATION_MS) {
    refusal('TEST_TABLE_EXPIRATION_REQUIRED');
  }
  const partitionExpiration = Number(metadata.defaultPartitionExpirationMs || 0);
  if (!Number.isFinite(partitionExpiration) || partitionExpiration !== 0) {
    refusal('TEST_PARTITION_EXPIRATION_FORBIDDEN');
  }
}

const response = () => ({ statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
  set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; return this; } });
const budget = title => ({ title, entity: 'SYNTHETIC TEST ONLY', year: '2026', revision: 0,
  rate: '710', rateSource: 'Synthetic assumption, not a market rate', rateDate: '2026-01-01',
  rows: ['CHF', 'CFA'].map((currency, index) => ({ id: `test-line-${index}`, label: 'Synthetic forecast',
    kind: 'operating', direction: 'out', currency, months: ['0', '12,50', ...Array(10).fill('')] })) });

function createBudgetTestQueryClient(client, config, report) {
  return { async query(options) {
    if (report.queries >= MAX_QUERIES) refusal('QUERY_LIMIT_REACHED');
    report.queries++;
    return client.query({ ...options, location: config.location, useLegacySql: false,
      useQueryCache: false, maximumBytesBilled: MAX_BYTES, jobTimeoutMs: 60000,
      jobPrefix: `m3s_budget_test_${report.runId}_`, labels: { purpose: 'm3s_budget_test' } });
  } };
}

async function runCloud(config, client, { log = () => {}, env = process.env } = {}) {
  // Validate even when called outside the CLI. No server.js, dotenv or production bootstrap is loaded.
  if (!config.execute) refusal('EXECUTION_REQUIRED');
  config = parseArgs(['--execute', '--project', config.projectId, '--dataset', config.datasetId,
    '--location', config.location, '--confirm', config.confirmation], env);
  const report = { mode: 'cloud', status: 'running', target: `${config.projectId}.${config.datasetId}`,
    runId: crypto.randomUUID(), checks: [], queries: 0, stage: 'dataset-guard',
    limits: ['Injected application identities; no JWT or deployed API verification.',
      'Cloud principal permissions exercised, not a full IAM least-privilege audit.',
      'No production activation. Test tables expire; no automatic deletion.'] };
  const run = async (name, fn) => { report.stage = name; await fn(); report.checks.push(name); log({ passed: name }); };
  try {
    const dataset = client.dataset(config.datasetId);
    const [metadata] = await dataset.getMetadata();
    assertTestDataset(metadata, config);
    const [tables, next] = await dataset.getTables({ maxResults: 1, autoPaginate: false });
    if (tables.length || next) refusal('EMPTY_DEDICATED_DATASET_REQUIRED');

    const queryClient = createBudgetTestQueryClient(client, config, report);
    const handlersFor = (bigquery = queryClient) => createBudgetDraftHandlers({ ...config, bigquery,
      enabled: true, logger: { error() {} } });
    const handlers = handlersFor();
    const actor = { id: `test-owner-${report.runId}`, tenantId: `test-org-${report.runId}`,
      permissions: ['finance:read', 'finance:write'], financePermissionsExplicit: true };
    const call = async (name, { user = actor, id, body, query = {} } = {}, api = handlers) => {
      const res = response(); await api[name]({ user, params: { id }, body, query }, res);
      assert.equal(res.headers['Cache-Control'], 'no-store'); return res;
    };
    const base = budget('Synthetic cloud acceptance');
    let id;
    await run('schema', async () => {
      for (const query of buildBudgetSchemaStatements(config)) await queryClient.query({ query });
    });
    await run('round-trip', async () => {
      const created = await call('create', { body: { budget: base } });
      assert.equal(created.statusCode, 201); id = created.body.data.id;
      const read = await call('get', { id });
      assert.equal(read.statusCode, 200); assert.equal(read.body.data.version, 1);
      assert.deepEqual(read.body.data.budget, base);
      const list = await call('list'); assert.equal(list.statusCode, 200);
      assert.deepEqual(list.body.data.map(row => row.id), [id]);
      assert.equal(list.body.hasMore, false);
      assert.equal(list.body.data[0].budget, undefined);
    });
    await run('read-only', async () => {
      const before = report.queries;
      const denied = await call('update', { id, user: { ...actor, permissions: ['finance:read'] },
        body: { budget: base, expectedVersion: 1 } });
      assert.equal(denied.statusCode, 403); assert.equal(report.queries, before);
    });
    for (const [name, user] of [
      ['owner-isolation', { ...actor, id: `test-other-${report.runId}` }],
      ['tenant-isolation', { ...actor, tenantId: `test-other-org-${report.runId}` }]
    ]) await run(name, async () => {
      const created = await call('create', { user, body: { budget: base } });
      assert.equal(created.statusCode, 201);
      const list = await call('list', { user }); assert.equal(list.statusCode, 200);
      assert.deepEqual(list.body.data.map(row => row.id), [created.body.data.id]);
      assert.equal((await call('get', { user, id })).statusCode, 404);
      assert.equal((await call('update', { user, id, body: { budget: base, expectedVersion: 1 } })).statusCode, 404);
    });
    await run('stale-version', async () => {
      assert.equal((await call('update', { id, body: { budget: base, expectedVersion: 1 } })).statusCode, 200);
      assert.equal((await call('update', { id, body: { budget: base, expectedVersion: 1 } })).statusCode, 409);
    });
    await run('competing-writers', async () => {
      const candidates = ['Writer A', 'Writer B'].map(title => ({ ...base, title }));
      // Intentionally race two real transactions against the same expected version.
      const settled = await Promise.allSettled(candidates.map(b => call('update', { id,
        body: { budget: b, expectedVersion: 2 } })));
      assert(settled.every(item => item.status === 'fulfilled'));
      const outcomes = settled.map(item => item.value);
      assert.deepEqual(outcomes.map(res => res.statusCode).sort(), [200, 409]);
      const read = await call('get', { id }); assert.equal(read.statusCode, 200);
      assert.equal(read.body.data.version, 3);
      assert.deepEqual(read.body.data.budget, candidates[outcomes.findIndex(res => res.statusCode === 200)]);
    });
    await run('atomic-rollback', async () => {
      const before = await call('get', { id });
      const failing = handlersFor({ query: options => {
        assert(options.query.includes('COMMIT TRANSACTION;'));
        return queryClient.query({ ...options, query: options.query.replace('COMMIT TRANSACTION;',
          "ASSERT FALSE AS 'Synthetic rollback test'; COMMIT TRANSACTION;") });
      } });
      const result = await call('update', { id, body: { budget: { ...base, title: 'Must roll back' },
        expectedVersion: 3 } }, failing);
      assert.equal(result.statusCode, 503);
      const after = await call('get', { id }); assert.equal(after.statusCode, 200);
      assert.deepEqual(after.body.data, before.body.data);
    });
    await run('uncertain-response', async () => {
      const uncertain = handlersFor({ async query(options) {
        await queryClient.query(options); throw new Error('Synthetic lost acknowledgement');
      } });
      const result = await call('create', { body: { budget: base } }, uncertain);
      assert.equal(result.statusCode, 503); assert.equal(result.body.reconcileRequired, true);
      const read = await call('get', { id: result.body.draftId });
      assert.equal(read.statusCode, 200); assert.equal(read.body.data.version, 1);
      assert.deepEqual(read.body.data.budget, base);
    });
    await run('audit', async () => {
      const ref = name => `\`${config.projectId}.${config.datasetId}.${name}\``;
      const [events] = await queryClient.query({ query: `SELECT version, action FROM ${ref('finance_budget_draft_events_v1')}
        WHERE draft_id = @id ORDER BY version`, params: { id } });
      assert.deepEqual(events.map(row => [Number(row.version), row.action]), [[1, 'created'], [2, 'updated'], [3, 'updated']]);
      const [counts] = await queryClient.query({ query: `SELECT
        (SELECT COUNT(*) FROM ${ref('finance_budget_drafts_v1')}) AS drafts,
        (SELECT COUNT(*) FROM ${ref('finance_budget_draft_events_v1')}) AS events` });
      assert.equal(Number(counts[0].drafts), 4); assert.equal(Number(counts[0].events), 6);
    });
    report.status = 'passed'; report.stage = 'complete';
  } catch (error) {
    report.status = 'failed'; report.reason = error.safeCode || 'CHECK_FAILED';
  }
  return report;
}

async function main(args = process.argv.slice(2), { env = process.env, log = value => console.log(JSON.stringify(value)),
  createClient = projectId => new (require('@google-cloud/bigquery').BigQuery)({ projectId, autoRetry: false }) } = {}) {
  try {
    const config = parseArgs(args, env);
    if (!config.execute) {
      log({ mode: 'plan', cloudAccess: false, executionAuthorized: false, checks,
        target: config.projectId ? `${config.projectId}.${config.datasetId}` : null,
        requires: ['Explicit project, m3s_budget_test_* dataset and location.',
          'Existing empty dataset labelled purpose=m3s_budget_test; whole-table expiry 2 hours to 7 days and no partition expiry.',
          'Test-scoped Google ADC identity; exact target confirmation with --execute --confirm.',
          'No dotenv, production startup, IAM mutation, dataset creation or data deletion.'],
        maxQueries: MAX_QUERIES, maximumBytesBilledPerJob: MAX_BYTES });
      return 0;
    }
    const report = await runCloud(config, createClient(config.projectId), { log, env });
    log(report); return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    log({ status: 'refused', reason: error.safeCode || 'SETUP_FAILED' }); return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { parseArgs, assertTestDataset, createBudgetTestQueryClient, runCloud, main };

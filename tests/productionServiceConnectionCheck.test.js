'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkProductionConnection, main } = require('../scripts/checkProductionConnection');

const env = { M3S_PRODUCTION_SERVICE_DB_PASSWORD: 'synthetic-distinct-secret-'.repeat(2),
  M3S_RH_DB_CA_PEM: '-----BEGIN CERTIFICATE-----\nsynthetic' };
function fixture({ failQuery, tls, versions, readonly = 'on', guardFails = false, releaseFails = false, endFails = false } = {}) {
  const queries = [];
  let options, released, ended = false, guardCalls = 0;
  const client = { async query(sql) {
    queries.push(sql);
    if (sql === failQuery) throw new Error(`private failure: ${env.M3S_PRODUCTION_SERVICE_DB_PASSWORD}`);
    if (sql === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: readonly }] };
    if (sql.includes('pg_stat_ssl')) return { rows: tls || [{ ssl: true, version: 'TLSv1.3', bits: 256 }] };
    if (sql.includes('schema_versions')) return { rows: versions || [{ version: 1 }] };
    return { rows: [] };
  }, release(broken) { released = broken; if (releaseFails) throw new Error('private release failure'); } };
  return { args: { env, createPool(config) { options = config; return {
    on() {}, async connect() { return client; }, async end() { ended = true; if (endFails) throw new Error('private end failure'); }
  }; }, async assertConnector(received) { guardCalls++; assert.equal(received, client); if (guardFails) throw new Error('private role failure'); } },
  state: () => ({ queries, options, released, ended, guardCalls }) };
}

test('default and plan modes never attempt a connection or require an environment secret', async () => {
  assert.deepEqual(await main([]), await main(['--plan']));
  assert.equal((await main([])).connectionAttempted, false);
  assert.equal((await main(['--check-read-only', '--password=do-not-accept'])).code, 'SERVICE_CHECK_ARGUMENTS');
});

test('missing, short and reused secrets fail before constructing a pool', async () => {
  for (const patch of [{ M3S_PRODUCTION_SERVICE_DB_PASSWORD: '' },
    { M3S_PRODUCTION_SERVICE_DB_PASSWORD: 'short' },
    { M3S_RH_DB_PASSWORD: env.M3S_PRODUCTION_SERVICE_DB_PASSWORD }, { M3S_RH_DB_CA_PEM: '' }]) {
    const result = await checkProductionConnection({ env: { ...env, ...patch }, createPool() { assert.fail('No connection allowed'); } });
    assert.equal(result.code, 'SERVICE_CHECK_CONFIGURATION');
  }
});

test('the check reuses the pinned TLS connector and runs only bounded read-only metadata queries', async () => {
  const f = fixture();
  const result = await checkProductionConnection(f.args);
  assert.equal(result.status, 'passed'); assert.equal(result.operationalSmokeTested, false);
  assert.equal(result.profileEnabled, false); assert.equal(result.activatesProfile, false);
  const state = f.state();
  assert.equal(state.options.max, 1); assert.equal(state.options.ssl.rejectUnauthorized, true);
  assert.equal(state.options.user, 'm3s_production_service_connector');
  assert.equal(state.guardCalls, 1); assert.equal(state.queries[0], 'BEGIN READ ONLY');
  assert.equal(state.queries.at(-1), 'ROLLBACK'); assert.equal(state.ended, true); assert.equal(state.released, false);
  assert(state.queries.every(sql => /^(BEGIN READ ONLY|SHOW |SELECT |ROLLBACK)/.test(sql)));
  assert(!JSON.stringify(result).includes(env.M3S_PRODUCTION_SERVICE_DB_PASSWORD));
});

test('qualified TLS 1.2 passes without enabling an absent profile', async () => {
  const f = fixture({ tls: [{ ssl: true, version: 'TLSv1.2', bits: 128 }] });
  assert.equal((await checkProductionConnection(f.args)).status, 'passed');
});

test('a refused connection is sanitised and the pool is closed', async () => {
  let ended = false;
  const result = await checkProductionConnection({ env, createPool() { return {
    on() {}, async connect() { throw new Error(env.M3S_PRODUCTION_SERVICE_DB_PASSWORD); },
    async end() { ended = true; }
  }; } });
  assert.deepEqual(result, { mode: 'read_only', status: 'failed', code: 'SERVICE_CHECK_CONNECTION' });
  assert.equal(ended, true);
});

test('an asynchronous pool error cannot produce a passing report', async () => {
  const f = fixture();
  const factory = f.args.createPool;
  f.args.createPool = options => {
    const pool = factory(options);
    pool.on = (_event, handler) => handler(new Error('private pool failure'));
    return pool;
  };
  assert.equal((await checkProductionConnection(f.args)).code, 'SERVICE_CHECK_CONNECTION');
  assert.equal(f.state().ended, true);
});

test('failed rollback discards the client rather than returning it to the pool', async () => {
  const f = fixture({ failQuery: 'ROLLBACK' });
  await checkProductionConnection(f.args);
  assert.equal(f.state().released, true);
});

for (const tls of [[], [{ ssl: false, version: 'TLSv1.3', bits: 256 }],
  [{ ssl: true, version: 'TLSv1', bits: 256 }], [{ ssl: true, version: 'TLSv1.3', bits: 64 }],
  [{ ssl: true, version: 'TLSv1.3' }]]) test(`rejects unqualified TLS ${JSON.stringify(tls)}`, async () => {
  const f = fixture({ tls });
  assert.equal((await checkProductionConnection(f.args)).code, 'SERVICE_CHECK_TLS');
  assert.equal(f.state().guardCalls, 0); assert.equal(f.state().ended, true);
});

for (const [settings, code] of [
  [{ readonly: 'off' }, 'SERVICE_CHECK_READ_ONLY'],
  [{ guardFails: true }, 'SERVICE_CHECK_PRIVILEGES'],
  [{ versions: [{ version: 2 }] }, 'SERVICE_CHECK_SCHEMA'],
  [{ versions: [] }, 'SERVICE_CHECK_SCHEMA'],
  [{ failQuery: 'ROLLBACK' }, 'SERVICE_CHECK_CLEANUP'],
  [{ releaseFails: true }, 'SERVICE_CHECK_CLEANUP'],
  [{ endFails: true }, 'SERVICE_CHECK_CLEANUP']
]) test(`refuses ${code} and closes the pool without exposing provider messages`, async () => {
  const f = fixture(settings);
  const result = await checkProductionConnection(f.args);
  assert.equal(result.code, code); assert.equal(result.status, 'failed');
  assert.equal(f.state().ended, true);
  assert(!JSON.stringify(result).includes('private'));
  assert(!JSON.stringify(result).includes(env.M3S_PRODUCTION_SERVICE_DB_PASSWORD));
});

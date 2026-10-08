'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { documentDatabaseOptions, createRhDocumentHost, assertConnectorAccess } = require('../rhDocumentBootstrap');
const env = { M3S_RH_DOCUMENT_PROFILE: 'rh-document-attachment-v1',
  M3S_RH_DOCUMENT_DB_PASSWORD: 'synthetic-document-only-1234567890123456789',
  M3S_RH_DB_PASSWORD: 'synthetic-reader-only-12345678901234567890',
  M3S_RH_DB_CA_PEM: '-----BEGIN CERTIFICATE-----synthetic' };
const identityRuntime = { mode: 'google', authenticate() {} };
const createRuntime = options => options?.qualified ? 'enabled' : 'closed';

test('fixed database destination, TLS verification and distinct secret', () => {
  const options = documentDatabaseOptions(env);
  assert.equal(options.user, 'm3s_rh_document_connector');
  assert.equal(options.host, 'postgres.railway.internal');
  assert.equal(options.ssl.rejectUnauthorized, true);
  for (const patch of [{ M3S_RH_DOCUMENT_DB_PASSWORD: '' },
    { M3S_RH_DOCUMENT_DB_PASSWORD: env.M3S_RH_DB_PASSWORD }, { M3S_RH_DB_CA_PEM: '' }]) {
    assert.throws(() => documentDatabaseOptions({ ...env, ...patch }), /RH_DOCUMENT_CONFIGURATION_UNAVAILABLE/);
  }
});
test('closed by default and without Google, no pool created', () => {
  for (const options of [{ env: {} }, { identityRuntime: { mode: 'legacy' } }]) {
    const host = createRhDocumentHost({ env, identityRuntime, createRuntime,
      createPool: () => assert.fail('unexpected pool'), ...options });
    assert.equal(host.router, 'closed');
  }
});
test('owned pool closes once and errors are redacted', async () => {
  let ends = 0, errorHandler;
  const warnings = [];
  const pool = { connect() {}, end() { ends++; }, on(event, handler) { errorHandler = handler; } };
  const host = createRhDocumentHost({ env, identityRuntime, createRuntime,
    createPool: () => pool, warn: value => warnings.push(value) });
  assert.equal(host.router, 'enabled');
  errorHandler(new Error('SECRET SQL DETAIL'));
  await Promise.all([host.close(), host.close()]);
  assert.equal(ends, 1);
  assert.deepEqual(warnings, ['RH_DOCUMENT_POOL_UNAVAILABLE']);
});
test('failed runtime creation releases the pool and stays closed', async () => {
  let ends = 0;
  const host = createRhDocumentHost({ env, identityRuntime,
    createPool: () => ({ connect() {}, on() {}, end() { ends++; } }),
    createRuntime: options => { if (options?.qualified) throw new Error('SECRET'); return 'closed'; } });
  assert.equal(host.router, 'closed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ends, 1);
});

const connector = { role: 'm3s_rh_document_connector', rolcanlogin: true, rolconnlimit: 2,
  memberships: 1, can_assume_writer: true, direct_access: false,
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
  rolbypassrls: false, rolinherit: false };
test('every checkout validates connector before assuming NOLOGIN writer', async () => {
  const queries = []; let checkedPool;
  const client = { async query(sql) { queries.push(sql); return { rows: [{ ...connector }] }; }, release() {} };
  const host = createRhDocumentHost({ env, identityRuntime,
    createPool: () => ({ connect: async () => client, on() {}, end() {} }),
    createRuntime: options => { checkedPool = options?.pool; return 'enabled'; } });
  await checkedPool.connect(); await checkedPool.connect();
  assert.deepEqual(queries.filter(sql => ['RESET ROLE', 'SET ROLE m3s_rh_document_writer'].includes(sql)),
    ['RESET ROLE', 'SET ROLE m3s_rh_document_writer', 'RESET ROLE', 'SET ROLE m3s_rh_document_writer']);
  await host.close();
});
test('connector role drift is refused, with no raw provider error', async () => {
  for (const patch of [{ role: 'postgres' }, { rolsuper: true }, { rolinherit: true },
    { memberships: 2 }, { can_assume_writer: false }, { direct_access: true },
    { rolcanlogin: false }, { rolconnlimit: -1 }]) {
    await assert.rejects(assertConnectorAccess({ async query() { return { rows: [{ ...connector, ...patch }] }; } }),
      { message: 'RH_DOCUMENT_SOURCE_UNAVAILABLE' });
  }
});
test('viewer activation requires exactly two SET-only memberships', async () => {
  const client = patch => ({async query(){return {rows:[{...connector,memberships:2,can_assume_viewer:true,...patch}]};}});
  await assertConnectorAccess(client({}), {viewer:true});
  for (const patch of [{memberships:1},{memberships:3},{can_assume_viewer:false},{direct_access:true}]) {
    await assert.rejects(assertConnectorAccess(client(patch),{viewer:true}),/RH_DOCUMENT_SOURCE_UNAVAILABLE/);
  }
});
test('failed connector checkout destroys the borrowed connection before runtime can use it', async () => {
  let checkedPool; const releases = [];
  const host = createRhDocumentHost({ env, identityRuntime,
    createPool: () => ({ on() {}, end() {}, async connect() { return {
      async query() { throw new Error('PRIVATE CONNECTION DETAIL'); }, release(broken) { releases.push(broken); }
    }; } }), createRuntime: options => { checkedPool = options?.pool; return 'enabled'; } });
  await assert.rejects(checkedPool.connect(), { message: 'RH_DOCUMENT_SOURCE_UNAVAILABLE' });
  assert.deepEqual(releases, [true]); await host.close();
});
test('real SQL connector assumes only the writer and refuses direct table privileges', async t => {
  const { PGlite } = require('@electric-sql/pglite');
  for (const extra of [false, true]) {
    const db = new PGlite(); t.after(() => db.close());
    await db.exec(`CREATE ROLE m3s_rh_document_writer NOLOGIN NOINHERIT;
      CREATE ROLE m3s_rh_document_connector LOGIN NOINHERIT CONNECTION LIMIT 2;
      GRANT m3s_rh_document_writer TO m3s_rh_document_connector WITH INHERIT FALSE, SET TRUE;
      CREATE TABLE public.synthetic_secret(id int);
      ${extra ? 'GRANT SELECT ON public.synthetic_secret TO m3s_rh_document_connector;' : ''}
      SET SESSION AUTHORIZATION m3s_rh_document_connector`);
    if (extra) await assert.rejects(assertConnectorAccess(db), { message: 'RH_DOCUMENT_SOURCE_UNAVAILABLE' });
    else {
      await assertConnectorAccess(db);
      await db.exec('SET ROLE m3s_rh_document_writer');
      await assertConnectorAccess(db);
    }
  }
});
test('server mounts document host before reader, protects private bodies and closes both pools', () => {
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  const source = readFileSync(resolve(__dirname, '../server.js'), 'utf8');
  assert(source.indexOf('app.use(RH_PREFIX, rhDocumentHost.router)') < source.indexOf('app.use(RH_PREFIX, rhReadHost.router)'));
  assert(source.includes('const hasPrivateBody = path => isPrivateGedRoute(path) || isPrivateRhRoute(path)'));
  assert(source.includes('Promise.allSettled([rhReturnHost.close(), rhDocumentHost.close(), rhReadHost.close()])'));
});

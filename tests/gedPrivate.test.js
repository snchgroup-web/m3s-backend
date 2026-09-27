const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { readPolicy, scopeFor, approvedDocument, digest } = require('../gedPrivatePolicy');
const { createRegister } = require('../gedPrivateRegister');
const { createGedRouter, createGedRuntime, databaseOptions, isPrivateGedRoute, assertDatabaseAccess } = require('../gedPrivate');
const { createIdentityProductionBridge } = require('../identityProductionBridge');

function fixture() {
  const bytes = Buffer.from('%PDF-1.4\nsynthetic-only-not-a-real-document\n%%EOF');
  const entry = { name: 'Synthetic invoice.pdf', sha256: digest(bytes), size: bytes.length };
  const owner = { userId: 'synthetic-user', organizationId: 'synthetic-org' };
  const env = { M3S_GED_PRIVATE_ENABLED: 'true', M3S_IDENTITY_MODE: 'google', API_REQUIRE_AUTH: 'true',
    M3S_GED_OWNER_JSON: JSON.stringify(owner), M3S_IDENTITY_BINDING_JSON: JSON.stringify({ ...owner, active: true }),
    M3S_GED_IMPORT_MANIFEST_JSON: JSON.stringify([entry]) };
  const principal = { id: owner.userId, tenantId: owner.organizationId, authProvider: 'google', role: 'Manager' };
  return { bytes, entry, owner, env, principal, policy: readPolicy(env) };
}

test('pilot is off by default and refuses incomplete or unbound configuration', () => {
  assert.equal(readPolicy({}), null);
  const { env } = fixture();
  for (const patch of [{ M3S_IDENTITY_MODE: 'legacy' }, { API_REQUIRE_AUTH: 'false' },
    { M3S_GED_OWNER_JSON: '{}' }, { M3S_IDENTITY_BINDING_JSON: '{}' }, { M3S_GED_IMPORT_MANIFEST_JSON: '[]' },
    { M3S_GED_IMPORT_MANIFEST_JSON: 'not-json' }]) assert.throws(() => readPolicy({ ...env, ...patch }));
});

test('manifest rejects duplicate hashes, paths, active names, extra fields and excessive sizes', () => {
  const { env, entry } = fixture();
  for (const entries of [[entry, entry], [{ ...entry, name: '../file.pdf' }], [{ ...entry, name: '<script>.pdf' }],
    [{ ...entry, arbitrary: true }], [{ ...entry, size: 1048577 }], [{ ...entry, sha256: 'x' }]]) {
    assert.throws(() => readPolicy({ ...env, M3S_GED_IMPORT_MANIFEST_JSON: JSON.stringify(entries) }));
  }
});

test('scope comes only from exact Google-linked principal, never the role', () => {
  const { policy, principal } = fixture();
  assert.deepEqual(scopeFor(policy, principal), { tenant: digest(principal.tenantId), owner: digest(principal.id) });
  for (const patch of [{ id: 'other' }, { tenantId: 'other' }, { authProvider: 'legacy' }]) {
    assert.throws(() => scopeFor(policy, { ...principal, ...patch, role: 'Admin' }));
  }
});

test('only exact approved PDF bytes are accepted', () => {
  const { policy, entry, bytes } = fixture();
  assert.deepEqual(approvedDocument(policy, entry.sha256, bytes), entry);
  for (const bad of [Buffer.from('%PDF-1.4 changed'), bytes.toString(), Buffer.alloc(0), null]) {
    assert.throws(() => approvedDocument(policy, entry.sha256, bad));
  }
  assert.throws(() => approvedDocument(policy, '0'.repeat(64), bytes));
});

test('classified DOCX files require exact operator-approved bytes; no generic Word upload is enabled', async t => {
  const f = fixture();
  f.bytes = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.from('SYNTHETIC WORD FIXTURE')]);
  f.entry = { name: 'Synthetic CV.docx', size: f.bytes.length, sha256: digest(f.bytes), category: 'personal' };
  f.policy = readPolicy({ ...f.env, M3S_GED_IMPORT_MANIFEST_JSON: JSON.stringify([f.entry]) });
  assert.deepEqual(approvedDocument(f.policy, f.entry.sha256, f.bytes), f.entry);
  for (const patch of [{ category: 'public' }, { name: 'Synthetic.docm' }, { category: undefined }]) {
    assert.throws(() => readPolicy({ ...f.env, M3S_GED_IMPORT_MANIFEST_JSON: JSON.stringify([{ ...f.entry, ...patch }]) }));
  }
  const app = await setup(t, { fixture: f });
  const imported = await app.upload(); assert.equal(imported.status, 201);
  assert.equal((await imported.json()).document.category, 'personal');
  const retry = await app.upload(); assert.equal(retry.status, 200); assert.equal((await retry.json()).created, false);
  const list = await (await fetch(app.base, { headers: app.headers })).json();
  assert.equal(list.approved[0].category, 'personal');
  const downloaded = await fetch(`${app.base}/${f.entry.sha256}/content`, { headers: app.headers });
  assert.equal(downloaded.headers.get('content-type'), require('../gedPrivatePolicy').DOCX_MIME);
  assert.match(downloaded.headers.get('content-disposition'), /attachment; filename="document.docx"/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), f.bytes);
  assert.equal((await app.upload({ body: Buffer.from('PK-wrong-file-content') })).status, 400);
  assert.equal((await app.upload({ headers: { ...app.headers, 'content-type': 'application/pdf' } })).status, 415);
});

test('DB options pin private hostname and restricted login and enforce certificate validation', () => {
  assert.throws(() => databaseOptions({}));
  const config = databaseOptions({ M3S_GED_DB_PASSWORD: 'synthetic-only'.repeat(4),
    M3S_GED_DB_CA_PEM: '-----BEGIN CERTIFICATE-----\nsynthetic' });
  assert.equal(config.host, 'postgres.railway.internal');
  assert.equal(config.user, 'm3s_ged_app'); assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.max, 3);
});

test('private route bypasses global body parsers, including case-insensitive Express paths', () => {
  for (const value of ['/api/ged/private', '/API/GED/PRIVATE/documents', '/api/ged/private/documents/abc']) assert.equal(isPrivateGedRoute(value), true);
  for (const value of ['/api/documents', '/api/ged/privately']) assert.equal(isPrivateGedRoute(value), false);
});

async function setup(t, overrides = {}) {
  const f = overrides.fixture || fixture();
  const rows = new Map(); const objects = new Map();
  const counters = { services: 0, audits: 0, creates: 0 };
  const storage = {
    async putIfAbsent({ key, bytes }) {
      const created = !objects.has(key);
      if (created) objects.set(key, Buffer.from(bytes));
      return { key, created, generation: '12345678901234567890', size: bytes.length, sha256: digest(bytes) };
    },
    async get(ref) {
      const bytes = objects.get(ref.key);
      if (!bytes || digest(bytes) !== ref.sha256) throw new Error('SENSITIVE_PROVIDER_FAILURE');
      return Buffer.from(bytes);
    }
  };
  const keyFor = (scope, id) => JSON.stringify([scope.tenant, scope.owner, id]);
  const register = {
    async list(scope) { return [...rows.values()].filter(row => row.tenant === scope.tenant && row.owner_id === scope.owner); },
    async read(scope, id) { return rows.get(keyFor(scope, id)) || null; },
    async create(scope, entry, generation) {
      const key = keyFor(scope, entry.sha256); const created = !rows.has(key);
      if (created) { counters.creates++; rows.set(key, { tenant: scope.tenant, owner_id: scope.owner,
        document_id: entry.sha256, filename: entry.name, byte_size: entry.size, generation, created_at: '2026-01-01' }); }
      return { row: rows.get(key), created };
    },
    async auditDownload() { counters.audits++; }
  };
  const authenticate = overrides.authenticate || ((req, res, next) => {
    if (req.get('authorization') !== 'Bearer synthetic-test') return res.status(401).json({ success: false });
    req.user = overrides.principal || f.principal; return next();
  });
  const app = express();
  app.use('/api/ged/private', createGedRouter({ policy: f.policy, authenticate,
    getServices: async () => { counters.services++; return { storage, register }; } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/ged/private/documents`;
  const headers = { authorization: 'Bearer synthetic-test', origin: 'https://seneswiss-group.com' };
  const upload = (extra = {}) => fetch(`${base}/${f.entry.sha256}`, { method: 'POST',
    headers: { ...headers, 'content-type': require('../gedPrivatePolicy').contentTypeFor(f.entry) }, body: f.bytes, ...extra });
  return { ...f, app, register, storage, rows, objects, counters, base, headers, upload };
}

test('HTTP import, list, retry and private attachment roundtrip', async t => {
  const f = await setup(t);
  let response = await f.upload(); assert.equal(response.status, 201);
  const imported = await response.json(); assert.equal(imported.created, true);
  assert.deepEqual(Object.keys(imported.document).sort(), ['category', 'contentType', 'createdAt', 'id', 'name', 'size']);
  response = await f.upload(); assert.equal(response.status, 200); assert.equal((await response.json()).created, false);
  assert.equal(f.counters.creates, 1); assert.equal(f.objects.size, 1);
  response = await fetch(f.base, { headers: f.headers }); assert.equal((await response.json()).documents.length, 1);
  response = await fetch(`${f.base}/${f.entry.sha256}/content`, { headers: f.headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes); assert.equal(f.counters.audits, 1);
});

test('denies absent identity and cross-origin writes before services or body processing', async t => {
  const f = await setup(t);
  assert.equal((await f.upload({ headers: { 'content-type': 'application/pdf' } })).status, 401);
  for (const origin of ['', 'https://untrusted.example']) {
    assert.equal((await f.upload({ headers: { authorization: 'Bearer synthetic-test', origin, 'content-type': 'application/pdf' } })).status, 403);
  }
  assert.equal(f.counters.services, 0);
});

test('a different administrator cannot read the approved manifest or import', async t => {
  const f = await setup(t, { principal: { ...fixture().principal, id: 'another-admin', role: 'Admin' } });
  assert.equal((await fetch(f.base, { headers: f.headers })).status, 403);
  assert.equal((await f.upload()).status, 403); assert.equal(f.counters.services, 0);
});

test('rejects unknown files, invalid content, MIME and compressed bodies', async t => {
  const f = await setup(t);
  assert.equal((await f.upload({ body: Buffer.from('%PDF-unknown') })).status, 400);
  assert.equal((await f.upload({ headers: { ...f.headers, 'content-type': 'application/json' } })).status, 415);
  assert.equal((await f.upload({ headers: { ...f.headers, 'content-type': 'application/pdf', 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await f.upload({ body: Buffer.alloc(1048577) })).status, 413);
  assert.equal(f.counters.services, 0);
});

test('register failure never reports import success and authorized retry reconciles one object', async t => {
  const f = await setup(t); const original = f.register.create;
  f.register.create = async () => { throw new Error('SENSITIVE_PROVIDER_FAILURE'); };
  const result = await f.upload(); assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /SENSITIVE/);
  assert.equal(f.objects.size, 1); assert.equal(f.rows.size, 0);
  f.register.create = original;
  assert.equal((await f.upload()).status, 201); assert.equal(f.rows.size, 1); assert.equal(f.objects.size, 1);
});

test('download fails closed on corrupt storage or missing mandatory audit', async t => {
  const f = await setup(t); await f.upload(); const original = f.storage.get;
  f.storage.get = async () => { throw new Error('provider'); };
  assert.equal((await fetch(`${f.base}/${f.entry.sha256}/content`, { headers: f.headers })).status, 503);
  f.storage.get = original;
  f.register.auditDownload = async () => { throw new Error('audit'); };
  assert.equal((await fetch(`${f.base}/${f.entry.sha256}/content`, { headers: f.headers })).status, 503);
});

test('disabled runtime never initializes a database', async t => {
  const app = express();
  app.use(createGedRuntime({ env: {}, identityRuntime: { authenticate: () => assert.fail() },
    dependencies: { pg: { Pool: class { constructor() { assert.fail(); } } } } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/documents`)).status, 503);
});

test('actual PostgreSQL-compatible DDL, RLS and transactional register prevent foreign access and mutation', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(readFileSync(require.resolve('../sql/ged-private-v1.sql'), 'utf8'));
  await db.exec(`CREATE ROLE m3s_ged_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT USAGE ON SCHEMA ged_private TO m3s_ged_app;
    GRANT SELECT, INSERT ON ged_private.documents TO m3s_ged_app;
    GRANT INSERT ON ged_private.events TO m3s_ged_app;
    SET ROLE m3s_ged_app;`);
  await assertDatabaseAccess({ query: sql => db.query(sql) });
  const pool = { async connect() { return { query: (sql, params) => db.query(sql, params), release() {} }; } };
  const register = createRegister(pool); const f = fixture(); const scope = scopeFor(f.policy, f.principal);
  const result = await register.create(scope, f.entry, '9007199254740993123'); assert.equal(result.created, true);
  assert.equal((await register.create(scope, f.entry, '9007199254740993123')).created, false);
  assert.equal((await register.list(scope)).length, 1);
  const other = { ...scope, owner: digest('another-user') };
  assert.equal(await register.read(other, f.entry.sha256), null); assert.equal((await register.list(other)).length, 0);
  assert.equal((await db.query('SELECT * FROM ged_private.documents')).rows.length, 0);
  await assert.rejects(db.query('DELETE FROM ged_private.documents'), /permission denied/);
  await assert.rejects(db.query("UPDATE ged_private.documents SET filename='changed.pdf'"), /permission denied/);
  await assert.rejects(db.query('TRUNCATE ged_private.documents'), /permission denied/);
  await register.auditDownload(scope, f.entry.sha256);
  await db.exec('RESET ROLE');
  const audit = await db.query('SELECT action FROM ged_private.events ORDER BY action');
  assert.deepEqual(audit.rows.map(row => row.action), ['download', 'import']);
  await db.exec('GRANT DELETE ON ged_private.documents TO m3s_ged_app; SET ROLE m3s_ged_app;');
  await assert.rejects(assertDatabaseAccess({ query: sql => db.query(sql) }), /GED_DATABASE_ROLE_DENIED/);
});

test('runtime rejects a superuser, role membership or unknown role', async () => {
  const base = { role: 'm3s_ged_app', memberships: 0, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
    rolreplication: false, rolbypassrls: false, rolinherit: false };
  for (const patch of [{ role: 'postgres' }, { rolsuper: true }, { memberships: 1 }, { rolbypassrls: true }, { rolinherit: true }]) {
    await assert.rejects(assertDatabaseAccess({ query: async () => ({ rows: [{ ...base, ...patch }] }) }), /GED_DATABASE_ROLE_DENIED/);
  }
});

test('production identity bridge protects new GED routes: revoked, no TOTP, inactive and foreign subjects denied', async t => {
  const now = Date.now();
  const f = fixture();
  const original = { uid: 'synthetic-subject', sub: 'synthetic-subject', aud: 'synthetic-project',
    iss: 'https://securetoken.google.com/synthetic-project', exp: Math.floor(now / 1000) + 3600,
    iat: Math.floor(now / 1000), auth_time: Math.floor(now / 1000), email_verified: true,
    firebase: { sign_in_second_factor: 'totp' } };
  let claims = original; let revoked = false; let active = true;
  const bridge = createIdentityProductionBridge({ mode: 'google', projectId: 'synthetic-project',
    authenticateLegacy: () => assert.fail('no legacy fallback'), now: () => now,
    auth: { verifyIdToken: async (_token, checkRevocation) => {
      assert.equal(checkRevocation, true); if (revoked) throw new Error('revoked'); return claims;
    } },
    readLinks: async () => [{ ...f.owner, projectId: 'synthetic-project', tenantId: null,
      subject: 'synthetic-subject', active, permissions: ['finance:read'] }],
    readAccounts: async () => [{ id: f.owner.userId, tenantId: f.owner.organizationId, active, permissions: ['finance:read'] }],
    loadProfile: async () => ({ id: f.owner.userId, tenantId: f.owner.organizationId, active, role: 'Manager' }) });
  const app = await setup(t, { authenticate: bridge.authenticate });
  const options = { headers: { ...app.headers, authorization: 'Bearer synthetic.jwt.token', 'content-type': 'application/pdf' } };
  assert.equal((await app.upload(options)).status, 201);
  const before = app.counters.services;
  revoked = true; assert.equal((await app.upload(options)).status, 401); revoked = false;
  active = false; assert.equal((await app.upload(options)).status, 401); active = true;
  claims = { ...original, firebase: {} }; assert.equal((await app.upload(options)).status, 401);
  claims = { ...original, uid: 'foreign', sub: 'foreign' }; assert.equal((await app.upload(options)).status, 401);
  assert.equal(app.counters.services, before);
});

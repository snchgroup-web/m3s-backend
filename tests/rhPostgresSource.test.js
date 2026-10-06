'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createRhPostgresSource, databaseOptions } = require('../rhPostgresSource');
const { createCurrentRhPolicy, scopeFor } = require('../rhReadPolicy');
const { createRhReadRuntime } = require('../rhReadRuntime');
const express = require('express');
const { once } = require('node:events');
const migration = fs.readFileSync(path.join(__dirname, '../sql/rh-private-v1.sql'), 'utf8');
const principal = { id: 'synthetic-user', tenantId: 'synthetic-org', authProvider: 'google' };
const hash = value => createHash('sha256').update(value).digest('hex');
const scope = { tenant: hash(principal.tenantId), owner: hash(principal.id) };
const employee = '11111111-1111-4111-8111-111111111111';

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(migration);
  await db.exec(`CREATE ROLE m3s_rh_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA rh_private TO m3s_rh_reader;
    GRANT SELECT ON rh_private.schema_versions,rh_private.employees,
      rh_private.employee_revisions,rh_private.entitlement_revisions TO m3s_rh_reader;`);
  let released = 0;
  const pool = { connect: async () => ({
    query: (sql, params) => db.query(sql, params), release: () => { released++; }
  }) };
  const reader = () => db.exec('SET ROLE m3s_rh_reader');
  const decision = async (revision, canRead) => {
    await db.exec('RESET ROLE');
    await db.query(`INSERT INTO rh_private.entitlement_revisions
      (tenant,owner_id,revision,can_read,decision_ref) VALUES($1,$2,$3,$4,'SYNTHETIC-DECISION')`,
    [scope.tenant, scope.owner, revision, canRead]);
    await reader();
  };
  const seed = async () => {
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO rh_private.employees(tenant,owner_id,employee_id) VALUES($1,$2,$3)',
      [scope.tenant, scope.owner, employee]);
    await db.query(`INSERT INTO rh_private.employee_revisions
      (tenant,owner_id,employee_id,revision,display_name,record_status,classification)
      VALUES($1,$2,$3,1,'Synthetic employee','draft','C3')`, [scope.tenant, scope.owner, employee]);
    await reader();
  };
  await reader();
  const source = createRhPostgresSource({ pool, qualified: true });
  const policy = createCurrentRhPolicy({ qualified: true, readBindings: source.readBindings });
  return { db, source, policy, decision, seed, pool, released: () => released };
}

test('empty initialization does not grant access or create an employee', async t => {
  const { source, policy, db } = await fixture(t);
  assert.deepEqual(await source.readBindings({ userId: principal.id, organizationId: principal.tenantId }), []);
  await assert.rejects(scopeFor(policy, principal, 'read'), { message: 'RH_ACCESS_DENIED' });
  await db.exec('RESET ROLE');
  for (const name of ['employees', 'creation_requests', 'employee_revisions', 'entitlement_revisions']) {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM rh_private.${name}`)).rows[0].n, 0);
  }
});

test('qualified read preserves unknown dates and returns only draft columns', async t => {
  const { source, policy, decision, seed, released } = await fixture(t);
  await seed(); await decision(1, true);
  const resolved = await scopeFor(policy, principal, 'read');
  assert.deepEqual(resolved, scope);
  const register = await source.getRegister();
  const rows = await register.list(resolved, { limit: 1, offset: 0 });
  assert.equal(rows.length, 1); assert.equal(rows[0].employment_start_date, null);
  assert.equal(rows[0].display_name, 'Synthetic employee');
  assert.equal(rows[0].classification, 'C3'); assert.equal(rows[0].record_status, 'draft');
  assert.equal(rows[0].identity_ref, undefined); assert.equal(rows[0].tenant, undefined);
  assert.equal(released(), 2);
});

test('current revocation is read on the next request and again before data selection', async t => {
  const { source, policy, decision, seed } = await fixture(t);
  await seed(); await decision(1, true);
  const resolved = await scopeFor(policy, principal, 'read');
  await decision(2, false);
  await assert.rejects(scopeFor(policy, principal, 'read'), { message: 'RH_ACCESS_DENIED' });
  await assert.rejects((await source.getRegister()).list(resolved), { message: 'RH_ACCESS_DENIED' });
});

test('another account or organization cannot read entitlements or drafts', async t => {
  const { source, policy, decision, seed } = await fixture(t);
  await seed(); await decision(1, true);
  for (const other of [{ ...principal, id: 'other-user' }, { ...principal, tenantId: 'other-org' }]) {
    await assert.rejects(scopeFor(policy, other, 'read'), { message: 'RH_ACCESS_DENIED' });
  }
  await assert.rejects((await source.getRegister()).list({ ...scope, owner: 'c'.repeat(64) }), { message: 'RH_ACCESS_DENIED' });
});

test('existing HTTP runtime consumes the PostgreSQL source and closes after a current withdrawal', async t => {
  const { source, decision, seed } = await fixture(t);
  await seed(); await decision(1, true);
  const app = express();
  app.use('/api/rh/private', createRhReadRuntime({ enabled: true, qualified: true, ...source,
    identityRuntime: { mode: 'google', authenticate: (req, _res, next) => { req.user = principal; next(); } } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/rh/private/employees?limit=1&offset=0`;
  const first = await fetch(url);
  assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'private, no-store');
  const body = await first.json();
  assert.equal(body.items.length, 1); assert.equal(body.items[0].employmentStartDate, null);
  assert.equal(body.items[0].identityRef, undefined); assert.equal(body.candidate, true);
  const accessUrl = url.slice(0, url.indexOf('/employees')) + '/access';
  const access = await fetch(accessUrl);
  assert.equal(access.status, 200);
  assert.equal(access.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await access.json(), { enabled: true, qualified: true,
    userId: principal.id, organizationId: principal.tenantId, revision: '1' });
  await decision(2, false);
  assert.equal((await fetch(accessUrl)).status, 403);
  const withdrawn = await fetch(url);
  assert.equal(withdrawn.status, 403); assert.deepEqual(await withdrawn.json(), { code: 'RH_ACCESS_DENIED' });
});

test('SQL reader cannot modify drafts, history or its own entitlement', async t => {
  const { db, decision } = await fixture(t);
  await decision(1, true);
  for (const name of ['schema_versions', 'employees', 'creation_requests', 'employee_revisions', 'entitlement_revisions']) {
    await assert.rejects(db.exec(`DELETE FROM rh_private.${name}`));
    await assert.rejects(db.exec(`TRUNCATE rh_private.${name}`));
  }
  await assert.rejects(db.exec("UPDATE rh_private.entitlement_revisions SET can_read=true"));
  await assert.rejects(db.exec('SELECT * FROM rh_private.creation_requests'));
  assert.equal((await db.query('SELECT * FROM rh_private.entitlement_revisions')).rows.length, 0);
});

test('weak SQL rights, missing version and absent RLS fail closed before reading drafts', async t => {
  const { source, db, decision } = await fixture(t);
  await decision(1, true);
  const mutations = [
    'GRANT INSERT ON rh_private.entitlement_revisions TO m3s_rh_reader',
    'ALTER TABLE rh_private.employees DISABLE ROW LEVEL SECURITY',
    'DELETE FROM rh_private.schema_versions'
  ];
  for (const mutation of mutations) {
    await db.exec('RESET ROLE; BEGIN');
    await db.exec(mutation);
    await db.exec('SET ROLE m3s_rh_reader');
    await assert.rejects(source.readBindings({ userId: principal.id, organizationId: principal.tenantId }), { message: 'RH_SERVICE_UNAVAILABLE' });
    // Source rolled back the nested transaction, including the synthetic mutation.
    await db.exec('RESET ROLE; SET ROLE m3s_rh_reader');
  }
});

test('unqualified injection, invalid pagination and failed SQL never leak provider details', async t => {
  const { source, pool } = await fixture(t);
  assert.throws(() => createRhPostgresSource({ pool }), { message: 'RH_SERVICE_UNAVAILABLE' });
  for (const input of [{ limit: 101 }, { offset: -1 }, { limit: '1;DROP' }]) {
    await assert.rejects((await source.getRegister()).list(scope, input), { message: 'RH_INVALID_PAGE' });
  }
  let released;
  const broken = createRhPostgresSource({ qualified: true, pool: { connect: async () => ({
    query: async () => { throw new Error('SECRET_PROVIDER_DETAIL'); },
    release: value => { released = value; }
  }) } });
  await assert.rejects(broken.readBindings({ userId: principal.id, organizationId: principal.tenantId }), { message: 'RH_SERVICE_UNAVAILABLE' });
  assert.equal(released, true);
});

test('a later public grant outside RH closes the reader before any dossier is returned', async t => {
  const { db, source, decision, seed } = await fixture(t);
  await seed(); await decision(1, true);
  await db.exec('RESET ROLE; CREATE TABLE public.synthetic_unrelated(id integer); GRANT SELECT ON public.synthetic_unrelated TO PUBLIC; SET ROLE m3s_rh_reader');
  await assert.rejects(source.readBindings({ userId: principal.id, organizationId: principal.tenantId }), { message: 'RH_SERVICE_UNAVAILABLE' });
  await assert.rejects((await source.getRegister()).list(scope), { message: 'RH_SERVICE_UNAVAILABLE' });
});

test('configuration pins a distinct reader, bounded pool and verified TLS, never GED credentials', () => {
  assert.throws(() => databaseOptions({ M3S_GED_DB_PASSWORD: 'x'.repeat(32) }), { message: 'RH_SERVICE_UNAVAILABLE' });
  const options = databaseOptions({ M3S_RH_DB_PASSWORD: 'synthetic'.repeat(4),
    M3S_RH_DB_CA_PEM: '-----BEGIN CERTIFICATE-----synthetic' });
  assert.equal(options.user, 'm3s_rh_reader'); assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.host, 'postgres.railway.internal'); assert.equal(options.max, 2);
});

test('initialization is operator-only, transactional and contains no real records, role or grant', async t => {
  const { db } = await fixture(t);
  const executable = migration.replace(/--[^\r\n]*/g, '');
  assert.doesNotMatch(executable, /\b(GRANT|CREATE ROLE|UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(executable, /\b(?:TABLE|SCHEMA|INTO|ON|FROM)\s+(?:ged_private|finance|payroll)\b/i);
  await db.exec('RESET ROLE');
  await assert.rejects(db.exec(migration));
  await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM rh_private.schema_versions')).rows[0].n, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const projectRequire = require;
const express = projectRequire('express');
const { PGlite } = projectRequire('@electric-sql/pglite');
const { createRhDocumentAttachmentRuntime } = require('../rhDocumentRuntime');
const { createRhPostgresSource } = require('../rhPostgresSource');
const { guardedAttachmentPool } = require('../rhDocumentAttachmentAccess');
const origin = 'https://synthetic-m3s.example.test';
const user = { id: 'synthetic-mount-user', tenantId: 'synthetic-mount-org', authProvider: 'google' };
const hash = value => createHash('sha256').update(value).digest('hex');
const scope = [hash(user.tenantId), hash(user.id)];
const employee = '11111111-1111-4111-8111-111111111111';
const path = `/employees/${employee}/contract-document-links`;
const body = { dossierRevision: 2, documentId: 'a'.repeat(64), versionId: 'b'.repeat(64), purpose: 'contract_draft' };

async function host(t, options = {}) {
  const state = { authentication: 0, connections: 0, releases: 0, enabled: true };
  const identityRuntime = { mode: 'google', authenticate(req, res, next) {
    state.authentication++;
    if (req.get('Authorization') === 'Bearer synthetic') req.user = user;
    next();
  } };
  const pool = options.pool || { connect() { state.connections++; throw new Error('PRIVATE SQL DETAIL'); } };
  const middleware = createRhDocumentAttachmentRuntime({ qualified: true, origins: [origin], identityRuntime, pool, ...options });
  const disabled = createRhDocumentAttachmentRuntime();
  const app = express();
  app.use('/candidate/rh', (req, res, next) => (state.enabled ? middleware : disabled)(req, res, next));
  app.get('/candidate/rh/employees', (req, res) => res.json({ existingReader: true }));
  app.use((req, res) => res.status(404).json({ code: 'NOT_FOUND' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
  async function request({ url = path, method = 'POST', auth = true, requestOrigin = origin } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = 'Bearer synthetic';
    if (requestOrigin !== null) headers.Origin = requestOrigin;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/candidate/rh${url}`, {
      method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { state, request };
}

test('candidate is closed without explicit qualification, Google runtime and pool; no authentication or connection', async t => {
  for (const options of [{ qualified: false }, { qualified: 'true' }, { identityRuntime: { mode: 'legacy' } }, { pool: {} }]) {
    const f = await host(t, options);
    const result = await f.request();
    assert.equal(result.status, 503); assert.deepEqual(result.data, { code: 'RH_DOCUMENT_NOT_ENABLED' });
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal(f.state.authentication, 0); assert.equal(f.state.connections, 0);
    assert.deepEqual((await f.request({ url: '/employees', method: 'GET' })).data, { existingReader: true });
  }
});

test('only the attachment POST is mounted; existing reads and unrelated mutations are not intercepted', async t => {
  const f = await host(t);
  assert.deepEqual((await f.request({ url: '/employees', method: 'GET' })).data, { existingReader: true });
  for (const [url, method] of [[path, 'GET'], [path, 'DELETE'], [path + '/content', 'GET'],
    [`/employees/${employee}/revisions`, 'POST'], ['/employees', 'POST']]) {
    assert.equal((await f.request({ url, method })).status, 404);
  }
  assert.equal(f.state.authentication, 0); assert.equal(f.state.connections, 0);
});

test('missing identity and foreign origin refuse before opening the explicitly supplied pool', async t => {
  const f = await host(t);
  assert.equal((await f.request({ auth: false })).status, 401);
  assert.equal((await f.request({ requestOrigin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await f.request({ requestOrigin: null })).status, 403);
  assert.equal(f.state.connections, 0);
});

test('storage failure is redacted and does not disable the pre-existing reader', async t => {
  const f = await host(t); const result = await f.request();
  assert.equal(result.status, 503); assert.deepEqual(result.data, { code: 'RH_ENTITLEMENT_SOURCE_UNAVAILABLE' });
  assert.equal(f.state.connections, 1); assert(!JSON.stringify(result.data).includes('PRIVATE'));
  assert.deepEqual((await f.request({ url: '/employees', method: 'GET' })).data, { existingReader: true });
});

test('a failed access preflight releases its client and destroys it when rollback also fails', async () => {
  for (const broken of [false, true]) {
    const queries = [], releases = [];
    const pool = guardedAttachmentPool({ connect: async () => ({ async query(sql) {
      queries.push(sql);
      if (sql === 'BEGIN READ ONLY') return {};
      if (sql === 'ROLLBACK' && !broken) return {};
      throw new Error('PRIVATE ROLE DETAIL');
    }, release(value) { releases.push(value); } }) });
    await assert.rejects(pool.connect(), { message: 'RH_DOCUMENT_SOURCE_UNAVAILABLE' });
    assert.equal(queries[0], 'BEGIN READ ONLY'); assert.equal(queries.at(-1), 'ROLLBACK');
    assert.deepEqual(releases, [broken]); assert(!queries.includes('COMMIT'));
  }
});

test('assembled SQL runtime persists once under a nonprivileged role, refuses revocation and can be disabled without deleting history', async t => {
  const db = new PGlite(); t.after(() => db.close());
  const backend = resolve(__dirname, '../sql');
  for (const name of ['rh-private-v1.sql', 'rh-reader-role-v1.sql']) await db.exec(readFileSync(resolve(backend, name), 'utf8'));
  for (const name of ['rh-contract-documents-candidate.sql', 'rh-document-sources-candidate.sql']) {
    await db.exec(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8'));
  }
  await db.query('INSERT INTO rh_private.employees(tenant,owner_id,employee_id) VALUES($1,$2,$3)', [...scope, employee]);
  await db.query(`INSERT INTO rh_private.employee_revisions(tenant,owner_id,employee_id,revision,display_name,record_status,classification)
    VALUES($1,$2,$3,2,'SYNTHETIC MOUNT','draft','C3')`, [...scope, employee]);
  await db.query(`INSERT INTO rh_private.entitlement_revisions(tenant,owner_id,revision,can_read,decision_ref)
    VALUES($1,$2,1,true,'SYNTHETIC-READ')`, scope);
  await db.query(`INSERT INTO rh_private.mutation_entitlement_revisions(tenant,owner_id,revision,can_revise,decision_ref)
    VALUES($1,$2,1,true,'SYNTHETIC-REVISE')`, scope);
  const reference = [...scope, employee, body.documentId, body.versionId];
  await db.query(`INSERT INTO rh_private.document_attachment_decision_revisions
    (tenant,owner_id,employee_id,dossier_revision,document_id,version_id,purpose,revision,can_attach,decision_ref)
    VALUES($1,$2,$3,2,$4,$5,'contract_draft',1,true,'SYNTHETIC-ATTACH')`, reference);
  await db.query(`INSERT INTO rh_private.contract_document_metadata_revisions
    (tenant,owner_id,employee_id,dossier_revision,document_id,version_id,purpose,metadata_revision,category,classification,record_status,trashed,source_ref)
    VALUES($1,$2,$3,2,$4,$5,'contract_draft',1,'rh','C3','draft',false,'SYNTHETIC-META')`, reference);
  await db.exec(`CREATE ROLE m3s_rh_document_writer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA rh_private TO m3s_rh_document_writer;
    GRANT SELECT ON rh_private.schema_versions,rh_private.entitlement_revisions,rh_private.employee_revisions,
      rh_private.mutation_entitlement_revisions,rh_private.document_attachment_decision_revisions,
      rh_private.contract_document_metadata_revisions,rh_private.contract_documents,rh_private.contract_document_links TO m3s_rh_document_writer;
    GRANT INSERT ON rh_private.contract_documents,rh_private.contract_document_links TO m3s_rh_document_writer;`);
  let acquisitions = 0, releases = 0;
  const pool = { connect: async () => { acquisitions++; return { query: (sql, params) => db.query(sql, params), release() { releases++; } }; } };
  const f = await host(t, { pool });
  // The operator/table owner is deliberately refused before any attachment.
  assert.equal((await f.request()).status, 503);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM rh_private.contract_documents')).rows[0].n, 0);
  await db.exec('SET ROLE m3s_rh_document_writer');
  const first = await f.request(); assert.equal(first.status, 201); assert.equal(first.data.replayed, false);
  const replay = await f.request(); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
  assert.equal(first.data.item.contractStatus, 'draft_not_signable');
  assert.equal(acquisitions, releases);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM rh_private.contract_document_links')).rows[0].n, 0);
  assert.equal((await db.query("SELECT has_table_privilege(current_user,'rh_private.employee_revisions','INSERT') AS allowed")).rows[0].allowed, false);
  await db.exec('RESET ROLE; GRANT DELETE ON rh_private.contract_documents TO m3s_rh_document_writer; SET ROLE m3s_rh_document_writer');
  assert.equal((await f.request()).status, 503);
  await db.exec('RESET ROLE; REVOKE DELETE ON rh_private.contract_documents FROM m3s_rh_document_writer; SET ROLE m3s_rh_document_writer');
  assert.equal((await f.request()).status, 200);
  for (const [change, undo] of [
    ['ALTER ROLE m3s_rh_document_writer INHERIT', 'ALTER ROLE m3s_rh_document_writer NOINHERIT'],
    ['ALTER TABLE rh_private.contract_documents NO FORCE ROW LEVEL SECURITY', 'ALTER TABLE rh_private.contract_documents FORCE ROW LEVEL SECURITY'],
    ['GRANT SELECT ON rh_private.employees TO m3s_rh_document_writer', 'REVOKE SELECT ON rh_private.employees FROM m3s_rh_document_writer'],
    ['REVOKE INSERT ON rh_private.contract_document_links FROM m3s_rh_document_writer', 'GRANT INSERT ON rh_private.contract_document_links TO m3s_rh_document_writer']
  ]) {
    await db.exec(`RESET ROLE; ${change}; SET ROLE m3s_rh_document_writer`);
    assert.equal((await f.request()).status, 503);
    await db.exec(`RESET ROLE; ${undo}; SET ROLE m3s_rh_document_writer`);
  }
  assert.equal((await f.request()).status, 200);
  await db.exec('RESET ROLE');
  await db.query(`INSERT INTO rh_private.document_attachment_decision_revisions
    (tenant,owner_id,employee_id,dossier_revision,document_id,version_id,purpose,revision,can_attach,decision_ref)
    VALUES($1,$2,$3,2,$4,$5,'contract_draft',2,false,'SYNTHETIC-WITHDRAW')`, reference);
  await db.exec('SET ROLE m3s_rh_document_writer');
  assert.equal((await f.request()).status, 403);
  f.state.enabled = false;
  const before = acquisitions;
  assert.equal((await f.request()).data.code, 'RH_DOCUMENT_NOT_ENABLED');
  assert.equal(acquisitions, before);
  assert.deepEqual((await f.request({ url: '/employees', method: 'GET' })).data, { existingReader: true });
  assert.equal(acquisitions, releases);
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM rh_private.contract_documents')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM rh_private.contract_document_links')).rows[0].n, 1);
  await db.exec('SET ROLE m3s_rh_reader');
  const reader = createRhPostgresSource({ pool, qualified: true });
  assert.deepEqual(await reader.readBindings({ userId: user.id, organizationId: user.tenantId }),
    [{ userId: user.id, organizationId: user.tenantId, permissions: ['read'] }]);
  const register = await reader.getRegister();
  assert.equal((await register.list({ tenant: scope[0], owner: scope[1] }))[0].employee_id, employee);
  f.state.enabled = true;
  assert.equal((await f.request()).status, 503);
  assert.equal(acquisitions, releases);
});

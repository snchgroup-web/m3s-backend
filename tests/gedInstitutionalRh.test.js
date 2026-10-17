'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto'), { once } = require('node:events');
const express = require('express');
const { PERMISSIONS } = require('../administrationRegistries');
const { PREFIX, BUNDLE_ID, REFERENCE, fileSpecs, validateRegistration, createRouter, createHost } = require('../gedInstitutionalRh');
const { createInstitutionalRouter } = require('../gedInstitutional');
const sha = value => createHash('sha256').update(value).digest('hex');
const user = { id: 'synthetic-rh-reader', tenantId: '2sg', authProvider: 'google', permissions: [PERMISSIONS.RESOURCES_READ] };
function registration() {
  const value = structuredClone(require('../referentiels/gedInstitutionalRhV01.json'));
  value.actorSha256 = sha(user.id); value.files.forEach(file => { file.generation = '123'; });
  return validateRegistration(value);
}
const links = () => ['GD-008', 'GD-009'].map(dossier_id => ({ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL', dossier_id,
  confidentiality: 'internal', record_status: 'validated_for_integration', evidence_ged_ref: REFERENCE }));
const identity = principal => ({ mode: 'google', authenticate(req, res, next) {
  if (req.get('Authorization') !== 'Bearer synthetic') return res.status(401).json({ code: 'AUTH_REQUIRED' });
  req.user = principal; next();
} });
const router = (options = {}) => createRouter({ enabled: true, identityRuntime: identity(user), registration: registration(),
  readLinks: async () => links(), getReader: async () => { throw Error('UNEXPECTED_READ'); }, origins: ['https://seneswiss-group.com'], ...options });
async function serve(t, handler) {
  const app = express(); app.use(PREFIX, handler); app.use('/api/ged/institutional', createInstitutionalRouter());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  return (suffix = '', options = {}) => fetch(base + suffix, { ...options, headers: { Authorization: 'Bearer synthetic', ...options.headers } });
}
test('RH registration pins eight exact hashes, sizes, names, cycle and dossiers', () => {
  const good = registration(); assert.equal(good.bundleId, BUNDLE_ID); assert.equal(good.files.length, 8);
  for (const change of [r => { r.files[0].generation = null; }, r => { r.files[0].size++; }, r => { r.files[0].sha256 = 'a'.repeat(64); },
    r => { r.files[0].name = 'other.html'; }, r => { r.files[0].url = 'https://other.invalid'; }, r => { r.dossiers = ['GD-005', 'GD-006']; },
    r => { r.cycleId = 'bccde91a-fedc-469a-ad65-ab2f212db959'; }, r => { r.files.pop(); }, r => { r.actorSha256 = ''; }]) {
    const candidate = structuredClone(good); change(candidate); assert.throws(() => validateRegistration(candidate), /RH_INSTITUTIONAL_CONFIGURATION/);
  }
});
test('RH metadata is eight inert files and does not collide with the older route', async t => {
  const response = await (await serve(t, router()))(); assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(payload.bundle.reference, REFERENCE); assert.deepEqual(payload.bundle.dossiers, ['GD-008', 'GD-009']);
  assert.equal(payload.bundle.files.length, 8); assert(payload.bundle.files.every(f => f.contentType === 'application/octet-stream'));
  assert(!/generation|actorSha256|gs:\/\//.test(JSON.stringify(payload)));
});
test('anonymous, other actor, tenant, legacy identity and missing permission disclose no RH files', async t => {
  let calls = 0;
  const request = await serve(t, router({ readLinks: async () => { calls++; return links(); } }));
  assert.equal((await request('', { headers: { Authorization: '' } })).status, 401); assert.equal(calls, 0);
  for (const principal of [{ ...user, id: 'other', role: 'Manager' }, { ...user, tenantId: 'other' }, { ...user, authProvider: 'legacy' }, { ...user, permissions: [] }]) {
    const response = await (await serve(t, router({ identityRuntime: identity(principal) })))(); assert.equal(response.status, 403);
    assert(!JSON.stringify(await response.json()).includes('PARCOURS'));
  }
});
test('both exact RH dossier links are required without replacing documentary links', async t => {
  for (const rows of [[], [links()[0]], [links()[0], links()[0]], links().map(r => ({ ...r, dossier_id: 'GD-005' })),
    links().map(r => ({ ...r, evidence_ged_ref: 'local/path' })), links().map(r => ({ ...r, confidentiality: 'restricted' }))]) {
    assert.equal((await (await serve(t, router({ readLinks: async () => rows })))()).status, 503);
  }
});
test('writes, HEAD, queries, foreign origins and unapproved files are denied', async t => {
  const request = await serve(t, router());
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal((await request('', { method })).status, 405);
  assert.equal((await request('?kind=documents')).status, 400);
  assert.equal((await request('', { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await request('/files/' + 'a'.repeat(64))).status, 404);
  assert.equal((await request('/files/%2e%2e%2fprivate')).status, 404);
});
test('RH download uses its exact file, remains inert and sanitises errors', async t => {
  const reg = registration(), bytes = Buffer.from('synthetic download'); let selected;
  const request = await serve(t, router({ registration: reg, getReader: async () => ({ get: async file => { selected = file; return bytes; } }) }));
  const response = await request('/files/' + reg.files[6].sha256); assert.equal(response.status, 200); assert.equal(selected, reg.files[6]);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const failed = await (await serve(t, router({ getReader: async () => { throw Error('C:/private credentials'); } })))('/files/' + reg.files[0].sha256);
  assert.deepEqual(await failed.json(), { code: 'RH_INSTITUTIONAL_UNAVAILABLE' });
});
test('missing profile or generations keep RH closed without cloud calls', async t => {
  const noCall = () => { throw Error('NO_CLOUD_CALL'); };
  for (const cfg of [{}, { M3S_GED_INSTITUTIONAL_PROFILE: 'document-cycle-v01' }, { M3S_GED_RH_INSTITUTIONAL_PROFILE: 'rh-cycle-v01' }]) {
    const reg = structuredClone(registration()); reg.files[0].generation = null;
    const host = createHost({ env: cfg, identityRuntime: identity(user), registration: reg, bigquery: { query: noCall }, createBucket: noCall, projectId: 'mon-projet-data-2sg', datasetId: 'm3s_2sg' });
    assert.equal((await (await serve(t, host.router))()).status, 503);
  }
});
test('RH host issues only a capped SELECT on its two target dossiers', async t => {
  const queries = [];
  const host = createHost({ env: { M3S_GED_RH_INSTITUTIONAL_PROFILE: 'rh-cycle-v01' }, identityRuntime: identity(user), registration: registration(),
    projectId: 'mon-projet-data-2sg', datasetId: 'm3s_2sg', bigquery: { query: async options => { queries.push(options); return [links()]; } }, createBucket: () => { throw Error('NO_OBJECT_READ'); } });
  assert.equal((await (await serve(t, host.router))()).status, 200);
  assert.equal(queries.length, 1); assert.match(queries[0].query, /^SELECT /); assert.deepEqual(queries[0].params, { tenant: '2sg', ids: ['GD-008', 'GD-009'] });
  assert.equal(queries[0].maximumBytesBilled, '10485760'); assert.equal(queries[0].location, 'US');
  assert.equal(fileSpecs.length, 8);
});

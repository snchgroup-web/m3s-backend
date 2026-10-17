'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto'), { once } = require('node:events');
const express = require('express');
const { PERMISSIONS } = require('../administrationRegistries');
const { PREFIX, BUNDLE_ID, REFERENCE, spec, expectedLinks, validateRegistration, createRouter, createHost } = require('../gedOffers');
const sha = value => createHash('sha256').update(value).digest('hex');
const user = { id: 'synthetic-offers-reader', tenantId: '2sg', authProvider: 'google', permissions: [PERMISSIONS.RESOURCES_READ] };
function canonicalRegistration() {
  return { schema: 'm3s.ged.offers-version.v1', bundleId: BUNDLE_ID, version: spec.version, tenantId: '2sg',
    actorSha256: require('../referentiels/gedInstitutionalV01.json').actorSha256, decisionReference: 'AUT-GED-OFFRES-20261017-CHEIKH',
    files: spec.files.map(file => ({ name: file.name, sha256: file.id, size: file.size, version: file.version, dossiers: [...file.dossiers], generation: '123' })) };
}
const trustedTestRegistration = () => ({ ...canonicalRegistration(), actorSha256: sha(user.id) });
const links = () => Object.entries(expectedLinks).map(([dossier_id, evidence_ged_ref]) => ({ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL',
  dossier_id, evidence_ged_ref, confidentiality: 'internal', record_status: 'validated_for_integration' }));
const identity = principal => ({ mode: 'google', authenticate(req, res, next) {
  if (req.get('Authorization') !== 'Bearer synthetic') return res.status(401).json({ code: 'AUTH_REQUIRED' });
  req.user = principal; next();
} });
const router = (options = {}) => createRouter({ enabled: true, identityRuntime: identity(user), registration: trustedTestRegistration(),
  readLinks: async () => links(), getReader: async () => { throw Error('UNEXPECTED_READ'); }, origins: ['https://seneswiss-group.com'], ...options });
async function serve(t, handler) {
  const app = express(); app.use(PREFIX, handler);
  app.use('/api/ged/institutional', (_req, res) => res.status(418).json({ oldRouteUntouched: true }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (suffix = '', options = {}) => fetch(`http://127.0.0.1:${server.address().port}${PREFIX}${suffix}`, {
    ...options, headers: { Authorization: 'Bearer synthetic', ...options.headers } });
}

test('supplement registration pins ten exact files, targets, versions and existing actor', () => {
  const good = validateRegistration(canonicalRegistration()); assert.equal(good.files.length, 10); assert(Object.isFrozen(good.files[0]));
  for (const mutate of [r => { r.actorSha256 = 'a'.repeat(64); }, r => { r.files.pop(); }, r => { r.files[0].generation = null; },
    r => { r.files[0].sha256 = 'a'.repeat(64); }, r => { r.files[0].name = 'OTHER.html'; }, r => { r.files[0].size++; },
    r => { r.files[0].version = '2'; }, r => { r.files[0].dossiers = ['GD-005']; }, r => { r.files[0].url = 'https://other.invalid'; },
    r => { r.decisionReference = 'OTHER'; }, r => { r.tenantId = 'other'; }]) {
    const candidate = structuredClone(good); mutate(candidate); assert.throws(() => validateRegistration(candidate), /INSTITUTIONAL_CONFIGURATION/);
  }
});

test('metadata resolves supplement ahead of old catch-all and preserves canonical references', async t => {
  const source = links(), before = structuredClone(source);
  const response = await (await serve(t, router({ readLinks: async () => source })))(); assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(payload.bundle.reference, REFERENCE); assert.equal(payload.bundle.files.length, 10);
  assert.equal(payload.bundle.canonicalReferencesPreserved, true); assert.deepEqual(source, before);
  assert(payload.bundle.files.every(file => file.contentType === 'application/octet-stream'));
  assert(!/generation|actorSha256|gs:\/\//.test(JSON.stringify(payload)));
});

test('other actor, tenant, legacy identity and missing permission cannot list files', async t => {
  let calls = 0;
  const request = await serve(t, router({ readLinks: async () => { calls++; return links(); } }));
  assert.equal((await request('', { headers: { Authorization: '' } })).status, 401); assert.equal(calls, 0);
  for (const principal of [{ ...user, id: 'other', role: 'Manager' }, { ...user, tenantId: 'other' }, { ...user, authProvider: 'legacy' }, { ...user, permissions: [] }]) {
    const response = await (await serve(t, router({ identityRuntime: identity(principal) })))(); assert.equal(response.status, 403);
    assert(!JSON.stringify(await response.json()).includes('SYNTHESE'));
  }
});

test('all four exact canonical links required for metadata and downloads', async t => {
  for (const rows of [[], links().slice(1), [...links().slice(1), links()[1]], links().map(r => ({ ...r, evidence_ged_ref: REFERENCE })),
    links().map(r => ({ ...r, confidentiality: 'public' })), links().map(r => ({ ...r, tenant_id: 'other' }))]) {
    const request = await serve(t, router({ readLinks: async () => rows }));
    assert.equal((await request()).status, 503); assert.equal((await request('/files/' + spec.files[0].id)).status, 503);
  }
});

test('writes, HEAD, foreign origin, query overrides and unlisted file ids are denied', async t => {
  const request = await serve(t, router());
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) assert.equal((await request('', { method })).status, 405);
  assert.equal((await request('?dossier=GD-999')).status, 400);
  assert.equal((await request('', { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await request('/files/' + 'f'.repeat(64))).status, 404);
  assert.equal((await request('/files/%2e%2e%2fprivate')).status, 404);
});

test('only selected registered file reaches existing reader and is served inert', async t => {
  const registration = trustedTestRegistration(), bytes = Buffer.from('synthetic supplement'); let selected;
  const request = await serve(t, router({ registration, getReader: async () => ({ get: async file => { selected = file; return bytes; } }) }));
  const response = await request('/files/' + registration.files[3].sha256);
  assert.equal(response.status, 200); assert.equal(selected, registration.files[3]);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('storage errors never disclose internal paths', async t => {
  const response = await (await serve(t, router({ getReader: async () => { throw Error('C:/private credentials'); } })))('/files/' + spec.files[0].id);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { code: 'INSTITUTIONAL_UNAVAILABLE' });
});

test('disabled or invalid registration remains closed without cloud access', async t => {
  for (const env of [{}, { M3S_GED_INSTITUTIONAL_PROFILE: 'document-cycle-v01' }]) {
    const bad = canonicalRegistration(); bad.files[0].generation = null;
    const host = createHost({ env, identityRuntime: identity(user), registration: bad,
      bigquery: { query: () => { throw Error('NO_CLOUD'); } }, projectId: 'mon-projet-data-2sg', datasetId: 'm3s_2sg' });
    assert.equal((await (await serve(t, host.router))()).status, 503);
  }
});

test('supplement concurrency bound does not leave occupied slots after completion', async t => {
  const release = []; let reads = 0;
  const request = await serve(t, router({ readLinks: () => { reads++; return new Promise(resolve => release.push(() => resolve(links()))); } }));
  const first = request(), second = request();
  for (let i = 0; reads < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(reads, 2); assert.equal((await request()).status, 429);
  release.splice(0).forEach(done => done()); assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  const third = request();
  for (let i = 0; reads < 3 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(reads, 3); release.splice(0).forEach(done => done()); assert.equal((await third).status, 200);
});

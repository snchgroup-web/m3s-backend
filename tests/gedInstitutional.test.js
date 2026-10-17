'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const express = require('express');
const { PERMISSIONS } = require('../administrationRegistries');
const { PREFIX, BUNDLE_ID, REFERENCE, BUCKET, validateRegistration, authorize, objectKey,
  createInstitutionalReader, createInstitutionalRouter, createInstitutionalHost } = require('../gedInstitutional');
const sha = value => createHash('sha256').update(value).digest('hex');
const user = { id: 'synthetic-institution-reader', tenantId: '2sg', authProvider: 'google', permissions: [PERMISSIONS.RESOURCES_READ] };
function registration() {
  const value = structuredClone(require('../referentiels/gedInstitutionalV01.json'));
  value.actorSha256 = sha(user.id);
  value.files.forEach(file => { file.generation = '123456789'; });
  return validateRegistration(value);
}
const linkRows = () => ['GD-005', 'GD-006'].map(dossier_id => ({ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL', dossier_id,
  confidentiality: 'internal', record_status: 'validated_for_integration', evidence_ged_ref: REFERENCE }));
const identity = principal => ({ mode: 'google', authenticate(req, res, next) {
  if (req.get('Authorization') !== 'Bearer synthetic') return res.status(401).json({ code: 'AUTH_REQUIRED' });
  req.user = principal; next();
} });
async function serve(t, router) {
  const app = express(); app.use(PREFIX, router); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = `http://127.0.0.1:${server.address().port}${PREFIX}/document-cycle-v01`;
  return (suffix = '', options = {}) => fetch(root + suffix, { ...options, headers: { Authorization: 'Bearer synthetic', ...options.headers } });
}
function router(options = {}) {
  return createInstitutionalRouter({ enabled: true, identityRuntime: identity(user), registration: registration(), readLinks: async () => linkRows(),
    getReader: async () => { throw Error('UNEXPECTED_OBJECT_READ'); }, origins: ['https://seneswiss-group.com'], ...options });
}

test('only this immutable V0.1 registration and completed generations qualify', () => {
  const value = registration(); assert.equal(value.bundleId, BUNDLE_ID); assert.equal(value.files.length, 5);
  for (const change of [r => { r.files[0].generation = null; }, r => { r.files[1].sha256 = 'a'.repeat(64); },
    r => { r.files.push({}); }, r => { r.dossiers.reverse(); }, r => { r.tenantId = 'other'; }, r => { r.version = '0.2'; },
    r => { r.files[0].url = 'https://evil.invalid'; }]) {
    const candidate = structuredClone(value); change(candidate); assert.throws(() => validateRegistration(candidate), /INSTITUTIONAL_CONFIGURATION/);
  }
});

test('actor, tenant, Google identity and resource permission are all required; manager grants nothing', () => {
  const value = registration(); authorize(value, user);
  for (const other of [undefined, { ...user, id: 'other', role: 'Manager' }, { ...user, tenantId: 'other' },
    { ...user, authProvider: 'legacy' }, { ...user, permissions: [] }, { ...user, id: '' }]) {
    assert.throws(() => authorize(value, other), /INSTITUTIONAL_FORBIDDEN/);
  }
});

function storageFixture({ content = Buffer.from('synthetic immutable bytes'), changed = {} } = {}) {
  const file = { name: 'SYNTHETIC.html', sha256: sha(content), size: content.length, generation: '123' };
  const reg = { tenantId: '2sg', files: [file] }; let requested;
  const metadata = { bucket: BUCKET, name: objectKey(reg, file), generation: file.generation, size: String(file.size),
    contentType: 'application/octet-stream', metadata: { sha256: file.sha256 }, ...changed };
  const target = { name: BUCKET, projectNumber: '39747051341', location: 'EUROPE-WEST6',
    iamConfiguration: { publicAccessPrevention: 'enforced', uniformBucketLevelAccess: { enabled: true } } };
  const bucket = { name: BUCKET, getMetadata: async () => [target], file(key, options) {
    requested = { key, options };
    return { getMetadata: async () => [metadata], createReadStream: options => {
      assert.deepEqual(options, { validation: 'crc32c', decompress: false }); return Readable.from([content]);
    } };
  } };
  return { file, reg, metadata, target, bucket, requested: () => requested };
}

test('object reader pins generation, validates target, size and digest, and never uses private keys', async () => {
  const f = storageFixture(), reader = createInstitutionalReader({ bucket: f.bucket, registration: f.reg });
  assert.equal((await reader.get(f.file)).toString(), 'synthetic immutable bytes');
  assert.match(f.requested().key, /^ged-institutionnel\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
  assert.deepEqual(f.requested().options, { generation: '123' });
  await assert.rejects(reader.get({ ...f.file }), /INSTITUTIONAL_NOT_FOUND/);
});

test('object metadata or bytes cannot substitute another generation or active content type', async () => {
  for (const changed of [{ generation: '124' }, { size: '1' }, { contentType: 'text/html' }, { contentEncoding: 'gzip' },
    { metadata: { sha256: 'f'.repeat(64) } }, { name: 'ged-private/v1/elsewhere' }]) {
    const f = storageFixture({ changed });
    await assert.rejects(createInstitutionalReader({ bucket: f.bucket, registration: f.reg }).get(f.file), /INSTITUTIONAL_INTEGRITY/);
  }
  const f = storageFixture(); f.target.iamConfiguration.publicAccessPrevention = 'inherited';
  await assert.rejects(createInstitutionalReader({ bucket: f.bucket, registration: f.reg }).get(f.file), /INSTITUTIONAL_UNAVAILABLE/);
  const g = storageFixture(); g.file.sha256 = 'a'.repeat(64); g.metadata.name = objectKey(g.reg, g.file); g.metadata.metadata.sha256 = g.file.sha256;
  await assert.rejects(createInstitutionalReader({ bucket: g.bucket, registration: g.reg }).get(g.file), /INSTITUTIONAL_INTEGRITY/);
});

test('unauthenticated requests fail before links, object metadata or bytes are read', async t => {
  let calls = 0;
  const request = await serve(t, router({ readLinks: async () => { calls++; return linkRows(); } }));
  const response = await request('', { headers: { Authorization: '' } });
  assert.equal(response.status, 401); assert.equal(calls, 0); assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('approved metadata exposes five inert files and one version, not storage keys, generations or actor id', async t => {
  const request = await serve(t, router()); const response = await request(); assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(payload.bundle.files.length, 5);
  assert.deepEqual(payload.bundle.dossiers, ['GD-005', 'GD-006']); assert.equal(payload.bundle.reference, REFERENCE);
  assert(payload.bundle.files.every(file => file.contentType === 'application/octet-stream'));
  assert(!JSON.stringify(payload).includes('generation')); assert(!JSON.stringify(payload).includes('actorSha256')); assert(!JSON.stringify(payload).includes('gs://'));
});

test('other actors and legacy accounts cannot get metadata with a Manager title', async t => {
  const request = await serve(t, router({ identityRuntime: identity({ ...user, id: 'other', role: 'Manager' }) }));
  assert.equal((await request()).status, 403);
});

test('both actual dossier references are required; duplicate, unrelated or private links fail closed', async t => {
  for (const rows of [[], [linkRows()[0]], [linkRows()[0], linkRows()[0]], linkRows().map(row => ({ ...row, tenant_id: 'other' })),
    linkRows().map(row => ({ ...row, evidence_ged_ref: 'local/path' })), linkRows().map(row => ({ ...row, confidentiality: 'restricted' }))]) {
    const request = await serve(t, router({ readLinks: async () => rows })); assert.equal((await request()).status, 503);
  }
});

test('no writes, HEAD, query parameters, foreign origins or unknown file references are accepted', async t => {
  const request = await serve(t, router());
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) assert.equal((await request('', { method })).status, 405);
  assert.equal((await request('?path=elsewhere')).status, 400);
  assert.equal((await request('', { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await request('/files/' + 'a'.repeat(64))).status, 404);
  assert.equal((await request('/files/%2e%2e%2fprivate')).status, 404);
});

test('HTML-like bytes are attachment-only octet streams with sandbox, no-store and nosniff', async t => {
  const bytes = Buffer.from('<script>not executed</script>');
  const reg = { ...registration(), files: [{ name: 'SYNTHETIC.html', sha256: sha(bytes), size: bytes.length, generation: '1' }] };
  const request = await serve(t, router({ registration: reg, getReader: async () => ({ get: async () => bytes }) }));
  const response = await request('/files/' + sha(bytes)); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /^attachment;/); assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('storage errors disclose neither local paths nor credentials', async t => {
  const value = registration();
  const request = await serve(t, router({ getReader: async () => { throw Error('C:/secret/path bearer-private-token'); } }));
  const response = await request('/files/' + value.files[0].sha256); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'INSTITUTIONAL_UNAVAILABLE' });
});

test('disabled or incomplete registration never creates a reader, query, connection or credential', async t => {
  const cfg = structuredClone(registration()); cfg.files[0].generation = null;
  const noRead = () => { throw Error('NO_EXTERNAL_CALL'); };
  for (const env of [{}, { M3S_GED_INSTITUTIONAL_PROFILE: 'document-cycle-v01' }]) {
    const host = createInstitutionalHost({ env, identityRuntime: identity(user), registration: cfg,
      projectId: 'mon-projet-data-2sg', datasetId: 'm3s_2sg', bigquery: { query: noRead }, createBucket: noRead });
    const request = await serve(t, host.router); assert.equal((await request()).status, 503);
  }
});

test('host only reads exact tenant/dossier evidence, never SQL mutations or all catalogue data', async t => {
  const queries = [];
  const host = createInstitutionalHost({ env: { M3S_GED_INSTITUTIONAL_PROFILE: 'document-cycle-v01' }, identityRuntime: identity(user),
    registration: registration(), projectId: 'mon-projet-data-2sg', datasetId: 'm3s_2sg',
    bigquery: { query: async options => { queries.push(options); return [linkRows()]; } }, createBucket: () => { throw Error('NOT_NEEDED_FOR_METADATA'); } });
  const request = await serve(t, host.router); assert.equal((await request()).status, 200);
  assert.equal(queries.length, 1); assert.match(queries[0].query, /^SELECT /);
  assert.deepEqual(queries[0].params, { tenant: '2sg', ids: ['GD-005', 'GD-006'] });
  assert.equal(queries[0].location, 'US'); assert(!/INSERT|UPDATE|DELETE|CREATE|ALTER/.test(queries[0].query));
  assert.equal(queries[0].maximumBytesBilled, '10485760');
});

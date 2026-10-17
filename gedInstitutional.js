'use strict';
const express = require('express');
const { createHash } = require('node:crypto');
const { PERMISSIONS } = require('./administrationRegistries');
const PREFIX = '/api/ged/institutional';
const BUNDLE_ID = 'b4bd0e9ea0a1b2b9a4d980c9722f0fd05c372723f433e6275f46e34d05ce3699';
const REFERENCE = `GED-INST-V01-${BUNDLE_ID}`;
const BUCKET = 'm3s-ged-prive-mon-projet-data-2sg';
const HASH = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const isInstitutionalGedRoute = value => typeof value === 'string' && (value.toLowerCase() === PREFIX || value.toLowerCase().startsWith(PREFIX + '/'));
const fileSpecs = Object.freeze([
  ['2SG_ORGANISATION_DOCUMENTAIRE_CYCLE_01_V0_1.md', '91666f950c35ef4dc2912ef4478c5c3cf7f9a9bcdeb2d88622d512ac88bcd009', 16068],
  ['2SG_ORGANISATION_DOCUMENTAIRE_CYCLE_01_V0_1.html', '3a967fa3c596eec8e73e2d6373586a561c24466b7b75eb9bfaa55c23120c2930', 2062160],
  ['REFERENCES_SOURCES_V0_1.csv', '4bd1a9d7ded698b9966c5280ae324266b3fd58b9397eebdc2ace509f4c3688c9', 5294],
  ['SOURCES_V0_1.json', '5f647b01eccc744b84efc4f9b84cde595a2a187ad5d6aed2e86ff66c375ee748', 9466],
  ['MANIFEST.json', BUNDLE_ID, 2020]
]);

function validateRegistration(value) {
  if (value?.schema !== 'm3s.ged.institutional-version.v1' || value.bundleId !== BUNDLE_ID || value.version !== '0.1' ||
      value.tenantId !== '2sg' || !HASH.test(value.actorSha256) ||
      value.decisionReference !== 'AUT-GED-INST-20261017-CHEIKH-V01' ||
      value.cycleId !== 'bccde91a-fedc-469a-ad65-ab2f212db959' ||
      !Array.isArray(value.dossiers) || value.dossiers.join(',') !== 'GD-005,GD-006' ||
      !Array.isArray(value.files) || value.files.length !== 5) fail('INSTITUTIONAL_CONFIGURATION');
  const copy = structuredClone(value);
  copy.files.forEach((file, index) => {
    const [name, hash, size] = fileSpecs[index];
    if (Object.keys(file).sort().join(',') !== 'generation,name,sha256,size' || file.name !== name || file.sha256 !== hash || file.size !== size ||
        typeof file.generation !== 'string' || !/^[1-9][0-9]{0,29}$/.test(file.generation)) fail('INSTITUTIONAL_CONFIGURATION');
    Object.freeze(file);
  });
  Object.freeze(copy.files); Object.freeze(copy.dossiers);
  return Object.freeze(copy);
}

function authorize(registration, user) {
  if (user?.authProvider !== 'google' || user.tenantId !== registration.tenantId || typeof user.id !== 'string' ||
      !user.id || user.id.length > 128 || digest(user.id) !== registration.actorSha256 ||
      !Array.isArray(user.permissions) || !user.permissions.includes(PERMISSIONS.RESOURCES_READ)) fail('INSTITUTIONAL_FORBIDDEN');
}

function objectKey(registration, file) {
  return `ged-institutionnel/v1/${digest(registration.tenantId)}/${file.sha256}`;
}

function createInstitutionalReader({ bucket, registration }) {
  if (bucket?.name !== BUCKET || typeof bucket.getMetadata !== 'function' || typeof bucket.file !== 'function') fail('INSTITUTIONAL_CONFIGURATION');
  return { async get(file) {
    if (!registration.files.includes(file)) fail('INSTITUTIONAL_NOT_FOUND');
    const [target] = await bucket.getMetadata();
    if (target?.name !== BUCKET || target.projectNumber !== '39747051341' || target.location !== 'EUROPE-WEST6' ||
        target.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
        target.iamConfiguration?.publicAccessPrevention !== 'enforced') fail('INSTITUTIONAL_UNAVAILABLE');
    const key = objectKey(registration, file);
    const pinned = bucket.file(key, { generation: file.generation });
    const [metadata] = await pinned.getMetadata();
    if (metadata?.bucket !== BUCKET || metadata.name !== key || metadata.generation !== file.generation ||
        String(metadata.size) !== String(file.size) || metadata.metadata?.sha256 !== file.sha256 ||
        metadata.contentType !== 'application/octet-stream' || metadata.contentEncoding) fail('INSTITUTIONAL_INTEGRITY');
    const stream = pinned.createReadStream({ validation: 'crc32c', decompress: false });
    const timer = setTimeout(() => stream.destroy(new Error('INSTITUTIONAL_UNAVAILABLE')), 15000); timer.unref();
    const chunks = []; let size = 0;
    try {
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) fail('INSTITUTIONAL_INTEGRITY');
        size += chunk.length;
        if (size > file.size) fail('INSTITUTIONAL_INTEGRITY');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      if (size !== file.size || digest(bytes) !== file.sha256) fail('INSTITUTIONAL_INTEGRITY');
      return bytes;
    } finally { clearTimeout(timer); stream.destroy(); }
  } };
}

function createInstitutionalRouter({ enabled = false, identityRuntime, registration, readLinks, getReader, origins = [] } = {}) {
  const router = express.Router(), allowedOrigins = new Set(origins);
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' });
    if (!enabled || identityRuntime?.mode !== 'google' || !registration) return res.status(503).json({ code: 'INSTITUTIONAL_NOT_ENABLED' });
    if (req.method !== 'GET') return res.status(405).set('Allow', 'GET').json({ code: 'INSTITUTIONAL_METHOD_DENIED' });
    if (req.get('Origin') && !allowedOrigins.has(req.get('Origin'))) return res.status(403).json({ code: 'INSTITUTIONAL_ORIGIN_DENIED' });
    Promise.resolve().then(() => identityRuntime.authenticate(req, res, next)).catch(next);
  });
  let inFlight = 0;
  router.use((req, res, next) => {
    try {
      authorize(registration, req.user);
      if (Object.keys(req.query).length || req.get('Content-Encoding')) fail('INSTITUTIONAL_INVALID');
      if (inFlight >= 2) return res.status(429).json({ code: 'INSTITUTIONAL_BUSY' });
      inFlight++; let released = false;
      const release = () => { if (!released) { released = true; inFlight--; } };
      res.once('finish', release); res.once('close', release); next();
    } catch (error) { next(error); }
  });
  const run = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  async function assertLinks() {
    const rows = await readLinks();
    if (!Array.isArray(rows) || rows.length !== 2 || new Set(rows.map(row => row.dossier_id)).size !== 2 ||
        rows.some(row => !registration.dossiers.includes(row.dossier_id) || row.tenant_id !== '2sg' ||
          row.portfolio_id !== 'PORT-2SG-GLOBAL' || row.confidentiality !== 'internal' || row.record_status !== 'validated_for_integration' ||
          row.evidence_ged_ref !== REFERENCE)) fail('INSTITUTIONAL_LINKS_UNAVAILABLE');
  }
  router.get('/document-cycle-v01', run(async (_req, res) => {
    await assertLinks();
    res.json({ success: true, bundle: { id: registration.bundleId, reference: REFERENCE, version: '0.1',
      classification: 'internal', role: 'preparation_evidence', cycleId: registration.cycleId, dossiers: registration.dossiers,
      files: registration.files.map(file => ({ id: file.sha256, name: file.name, size: file.size, contentType: 'application/octet-stream' })) } });
  }));
  router.get('/document-cycle-v01/files/:id', run(async (req, res) => {
    const file = HASH.test(req.params.id) && registration.files.find(row => row.sha256 === req.params.id);
    if (!file) fail('INSTITUTIONAL_NOT_FOUND');
    await assertLinks();
    const bytes = await (await getReader()).get(file);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${file.name}"` });
    res.send(bytes);
  }));
  router.use((_req, res) => res.status(404).json({ code: 'INSTITUTIONAL_NOT_FOUND' }));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = { INSTITUTIONAL_FORBIDDEN: 403, INSTITUTIONAL_INVALID: 400, INSTITUTIONAL_NOT_FOUND: 404 }[error?.code] || 503;
    const code = [403, 400, 404].includes(status) ? error.code : 'INSTITUTIONAL_UNAVAILABLE';
    res.status(status).json({ code });
  });
  return router;
}

function createInstitutionalHost({ env = {}, identityRuntime, bigquery, credentials, origins = [],
  projectId, datasetId, registration = require('./referentiels/gedInstitutionalV01.json'), createBucket, warn = () => {} } = {}) {
  const closed = () => ({ router: createInstitutionalRouter() });
  if (env.M3S_GED_INSTITUTIONAL_PROFILE !== 'document-cycle-v01' || identityRuntime?.mode !== 'google') return closed();
  try {
    const pinned = validateRegistration(registration);
    if (projectId !== 'mon-projet-data-2sg' || datasetId !== 'm3s_2sg' || typeof bigquery?.query !== 'function') fail('INSTITUTIONAL_CONFIGURATION');
    let reader;
    const getReader = async () => {
      if (!reader) {
        if (!createBucket && credentials?.client_email !== 'm3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com') fail('INSTITUTIONAL_CONFIGURATION');
        const bucket = createBucket ? createBucket() : new (require('@google-cloud/storage').Storage)({ projectId, credentials,
          timeout: 10000, retryOptions: { autoRetry: false, maxRetries: 0 } }).bucket(BUCKET);
        reader = createInstitutionalReader({ bucket, registration: pinned });
      }
      return reader;
    };
    return { router: createInstitutionalRouter({ enabled: true, identityRuntime, registration: pinned, origins, getReader,
      readLinks: async () => (await bigquery.query({ query: 'SELECT tenant_id,portfolio_id,dossier_id,confidentiality,record_status,evidence_ged_ref FROM `mon-projet-data-2sg.m3s_2sg.management_dossiers` WHERE tenant_id=@tenant AND dossier_id IN UNNEST(@ids) ORDER BY dossier_id LIMIT 3',
        params: { tenant: pinned.tenantId, ids: pinned.dossiers }, location: 'US', maximumBytesBilled: '10485760' }))[0] }) };
  } catch { warn('INSTITUTIONAL_CONFIGURATION_UNAVAILABLE'); return closed(); }
}
module.exports = { PREFIX, BUNDLE_ID, REFERENCE, BUCKET, fileSpecs, validateRegistration, authorize, objectKey,
  isInstitutionalGedRoute, createInstitutionalReader, createInstitutionalRouter, createInstitutionalHost };

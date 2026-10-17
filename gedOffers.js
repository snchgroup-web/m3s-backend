'use strict';
const express = require('express');
const { createHash } = require('node:crypto');
const { authorize, createInstitutionalReader, REFERENCE: DOCUMENT_REFERENCE } = require('./gedInstitutional');
const { REFERENCE: RH_REFERENCE } = require('./gedInstitutionalRh');
const spec = require('./referentiels/gedOffersSpec.json');
const actor = require('./referentiels/gedInstitutionalV01.json').actorSha256;
const PREFIX = '/api/ged/institutional/offers-20261017';
const BUNDLE_ID = 'a49d924c3acf9b924f118268c23e320e4919d4d4309fbdf3f83d8fd990950318';
const REFERENCE = `GED-OFFRES-${BUNDLE_ID}`;
const HASH = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const expectedLinks = { 'GD-005': DOCUMENT_REFERENCE, 'GD-006': DOCUMENT_REFERENCE, 'GD-008': RH_REFERENCE, 'GD-009': RH_REFERENCE };

function validateRegistration(value) {
  const descriptor = { version: spec.version, dossiers: spec.dossiers, files: spec.files };
  if (spec.id !== BUNDLE_ID || digest(JSON.stringify(descriptor)) !== BUNDLE_ID ||
      value?.schema !== 'm3s.ged.offers-version.v1' || value.bundleId !== BUNDLE_ID || value.version !== spec.version ||
      value.tenantId !== '2sg' || value.actorSha256 !== actor ||
      value.decisionReference !== 'AUT-GED-OFFRES-20261017-CHEIKH' || !Array.isArray(value.files) || value.files.length !== 10) fail('INSTITUTIONAL_CONFIGURATION');
  const copy = structuredClone(value);
  copy.files.forEach((file, index) => {
    const expected = spec.files[index];
    if (Object.keys(file).sort().join(',') !== 'dossiers,generation,name,sha256,size,version' ||
        file.name !== expected.name || file.sha256 !== expected.id || file.size !== expected.size || file.version !== expected.version ||
        JSON.stringify(file.dossiers) !== JSON.stringify(expected.dossiers) ||
        typeof file.generation !== 'string' || !/^[1-9][0-9]{0,29}$/.test(file.generation)) fail('INSTITUTIONAL_CONFIGURATION');
    Object.freeze(file.dossiers); Object.freeze(file);
  });
  Object.freeze(copy.files);
  return Object.freeze(copy);
}

function createRouter({ enabled = false, identityRuntime, registration, readLinks, getReader, origins = [] } = {}) {
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
    if (!Array.isArray(rows) || rows.length !== 4 || new Set(rows.map(row => row.dossier_id)).size !== 4 ||
        rows.some(row => row.tenant_id !== '2sg' || row.portfolio_id !== 'PORT-2SG-GLOBAL' || row.confidentiality !== 'internal' ||
          row.record_status !== 'validated_for_integration' || !Object.hasOwn(expectedLinks, row.dossier_id) ||
          row.evidence_ged_ref !== expectedLinks[row.dossier_id])) fail('INSTITUTIONAL_LINKS_UNAVAILABLE');
  }
  router.get('/', run(async (_req, res) => {
    await assertLinks();
    res.json({ success: true, bundle: { id: BUNDLE_ID, reference: REFERENCE, version: spec.version,
      classification: 'internal', role: 'supplementary_resources', dossiers: spec.dossiers, canonicalReferencesPreserved: true,
      files: registration.files.map(file => ({ id: file.sha256, name: file.name, size: file.size, version: file.version,
        dossiers: file.dossiers, contentType: 'application/octet-stream' })) } });
  }));
  router.get('/files/:id', run(async (req, res) => {
    const file = HASH.test(req.params.id) && registration.files.find(item => item.sha256 === req.params.id);
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
    res.status(status).json({ code: [403, 400, 404].includes(status) ? error.code : 'INSTITUTIONAL_UNAVAILABLE' });
  });
  return router;
}

function createHost({ env = {}, identityRuntime, bigquery, credentials, origins = [], projectId, datasetId, registration, createBucket, warn = () => {} } = {}) {
  const closed = () => ({ router: createRouter() });
  if (env.M3S_GED_INSTITUTIONAL_PROFILE !== 'document-cycle-v01' || identityRuntime?.mode !== 'google') return closed();
  try {
    const pinned = validateRegistration(registration || require('./referentiels/gedOffersRegistration.json'));
    if (projectId !== 'mon-projet-data-2sg' || datasetId !== 'm3s_2sg' || typeof bigquery?.query !== 'function') fail('INSTITUTIONAL_CONFIGURATION');
    let reader;
    const getReader = async () => {
      if (!reader) {
        if (!createBucket && credentials?.client_email !== 'm3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com') fail('INSTITUTIONAL_CONFIGURATION');
        const bucket = createBucket ? createBucket() : new (require('@google-cloud/storage').Storage)({ projectId, credentials,
          timeout: 10000, retryOptions: { autoRetry: false, maxRetries: 0 } }).bucket('m3s-ged-prive-mon-projet-data-2sg');
        reader = createInstitutionalReader({ bucket, registration: pinned });
      }
      return reader;
    };
    return { router: createRouter({ enabled: true, identityRuntime, registration: pinned, origins, getReader,
      readLinks: async () => (await bigquery.query({ query: 'SELECT tenant_id,portfolio_id,dossier_id,confidentiality,record_status,evidence_ged_ref FROM `mon-projet-data-2sg.m3s_2sg.management_dossiers` WHERE tenant_id=@tenant AND dossier_id IN UNNEST(@ids) ORDER BY dossier_id LIMIT 5',
        params: { tenant: pinned.tenantId, ids: spec.dossiers }, location: 'US', maximumBytesBilled: '10485760' }))[0] }) };
  } catch { warn('INSTITUTIONAL_OFFERS_CONFIGURATION_UNAVAILABLE'); return closed(); }
}
module.exports = { PREFIX, BUNDLE_ID, REFERENCE, spec, expectedLinks, validateRegistration, createRouter, createHost };

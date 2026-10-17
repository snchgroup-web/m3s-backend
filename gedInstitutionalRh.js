'use strict';
const express = require('express');
const { authorize, createInstitutionalReader, BUCKET } = require('./gedInstitutional');
const PREFIX = '/api/ged/institutional/rh-cycle-v01';
const BUNDLE_ID = 'a58ea347ee3225a66bd7e58f7bcbc5ee5be8d45ba1f9fdcd769647cf6230d9a0';
const REFERENCE = `GED-RH-INST-V01-${BUNDLE_ID}`;
const CYCLE_ID = 'cdd7c770-b06e-416a-8d06-4299f80a71de';
const HASH = /^[a-f0-9]{64}$/;
const fileSpecs = Object.freeze([
  ['01_PARCOURS_ET_INTERFACES_V0_1.md', '3dd3ae174a19de608e7c17a50570fab859745a0ec4dd7c1b052925fd8d4a954b', 6094],
  ['02_INDEX_SOURCES_ET_OUTILS_V0_1.md', 'a68e1a224bee153548fdba6eb16a577e6029de32f4cdda9e50fd157a42a2b420', 4806],
  ['03_PRISE_EN_MAIN_ET_CONSERVATION_V0_1.md', '7e3fd9ec252ded89da4bbbc589dbcd4ef8d39e51d4e0e1c347fded1b55c95fac', 6461],
  ['04_POINTS_OUVERTS_ET_PASSAGES_V0_1.md', '6d1c2a4cdb33f8dac267ebdb53cffafd5ed4970c8b95e30807dd0bbcdc6f0d05', 6469],
  ['REFERENCES_SOURCES_V0_1.csv', 'f54be5219017bc7f1d973dc17bb53227429a6a912a19db60fe4e89a974498466', 4984],
  ['SOURCES_V0_1.json', '5ddffd908dc8b0a3689b6262a832db6e9a0f531dc9de5144ee6b08bcdb30cabb', 6896],
  ['2SG_RH_PROXIMITE_CYCLE_01_V0_1.html', 'ca9908ec43b9ca33c1359b64e230bc51e815ce09240a93d96e0e2b6fb5ce640a', 2121303],
  ['MANIFEST.json', BUNDLE_ID, 5052],
]);
const fail = code => { throw Object.assign(new Error(code), { code }); };

function validateRegistration(value) {
  if (value?.schema !== 'm3s.ged.institutional-rh-version.v1' || value.bundleId !== BUNDLE_ID || value.version !== '0.1' ||
      value.tenantId !== '2sg' || !HASH.test(value.actorSha256) ||
      value.decisionReference !== 'AUT-GED-RH-INST-20261017-CHEIKH-V01' || value.cycleId !== CYCLE_ID ||
      !Array.isArray(value.dossiers) || value.dossiers.join(',') !== 'GD-008,GD-009' || !Array.isArray(value.files) || value.files.length !== 8) fail('RH_INSTITUTIONAL_CONFIGURATION');
  const copy = structuredClone(value);
  copy.files.forEach((file, index) => {
    const [name, hash, size] = fileSpecs[index];
    if (Object.keys(file).sort().join(',') !== 'generation,name,sha256,size' || file.name !== name || file.sha256 !== hash || file.size !== size ||
        typeof file.generation !== 'string' || !/^[1-9][0-9]{0,29}$/.test(file.generation)) fail('RH_INSTITUTIONAL_CONFIGURATION');
    Object.freeze(file);
  });
  Object.freeze(copy.files); Object.freeze(copy.dossiers);
  return Object.freeze(copy);
}

function createRouter({ enabled = false, identityRuntime, registration, readLinks, getReader, origins = [] } = {}) {
  const router = express.Router(), allowedOrigins = new Set(origins);
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' });
    if (!enabled || identityRuntime?.mode !== 'google' || !registration) return res.status(503).json({ code: 'RH_INSTITUTIONAL_NOT_ENABLED' });
    if (req.method !== 'GET') return res.status(405).set('Allow', 'GET').json({ code: 'RH_INSTITUTIONAL_METHOD_DENIED' });
    if (req.get('Origin') && !allowedOrigins.has(req.get('Origin'))) return res.status(403).json({ code: 'RH_INSTITUTIONAL_ORIGIN_DENIED' });
    Promise.resolve().then(() => identityRuntime.authenticate(req, res, next)).catch(next);
  });
  let inFlight = 0;
  router.use((req, res, next) => {
    try {
      authorize(registration, req.user);
      if (Object.keys(req.query).length || req.get('Content-Encoding')) fail('RH_INSTITUTIONAL_INVALID');
      if (inFlight >= 2) return res.status(429).json({ code: 'RH_INSTITUTIONAL_BUSY' });
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
          row.evidence_ged_ref !== REFERENCE)) fail('RH_INSTITUTIONAL_LINKS_UNAVAILABLE');
  }
  router.get('/', run(async (_req, res) => {
    await assertLinks();
    res.json({ success: true, bundle: { id: registration.bundleId, reference: REFERENCE, version: '0.1',
      classification: 'internal', role: 'preparation_evidence', cycleId: registration.cycleId, dossiers: registration.dossiers,
      files: registration.files.map(file => ({ id: file.sha256, name: file.name, size: file.size, contentType: 'application/octet-stream' })) } });
  }));
  router.get('/files/:id', run(async (req, res) => {
    const file = HASH.test(req.params.id) && registration.files.find(row => row.sha256 === req.params.id);
    if (!file) fail('RH_INSTITUTIONAL_NOT_FOUND');
    await assertLinks();
    const bytes = await (await getReader()).get(file);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'Content-Disposition': `attachment; filename="${file.name}"` });
    res.send(bytes);
  }));
  router.use((_req, res) => res.status(404).json({ code: 'RH_INSTITUTIONAL_NOT_FOUND' }));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = { INSTITUTIONAL_FORBIDDEN: 403, RH_INSTITUTIONAL_INVALID: 400, RH_INSTITUTIONAL_NOT_FOUND: 404 }[error?.code] || 503;
    res.status(status).json({ code: status === 503 ? 'RH_INSTITUTIONAL_UNAVAILABLE' : error.code });
  });
  return router;
}

function createHost({ env = {}, identityRuntime, bigquery, credentials, origins = [], projectId, datasetId,
  registration = require('./referentiels/gedInstitutionalRhV01.json'), createBucket, warn = () => {} } = {}) {
  const closed = () => ({ router: createRouter() });
  if (env.M3S_GED_RH_INSTITUTIONAL_PROFILE !== 'rh-cycle-v01' || identityRuntime?.mode !== 'google') return closed();
  try {
    const pinned = validateRegistration(registration);
    if (projectId !== 'mon-projet-data-2sg' || datasetId !== 'm3s_2sg' || typeof bigquery?.query !== 'function') fail('RH_INSTITUTIONAL_CONFIGURATION');
    let reader;
    const getReader = async () => {
      if (!reader) {
        if (!createBucket && credentials?.client_email !== 'm3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com') fail('RH_INSTITUTIONAL_CONFIGURATION');
        const bucket = createBucket ? createBucket() : new (require('@google-cloud/storage').Storage)({ projectId, credentials,
          timeout: 10000, retryOptions: { autoRetry: false, maxRetries: 0 } }).bucket(BUCKET);
        reader = createInstitutionalReader({ bucket, registration: pinned });
      }
      return reader;
    };
    return { router: createRouter({ enabled: true, identityRuntime, registration: pinned, origins, getReader,
      readLinks: async () => (await bigquery.query({ query: 'SELECT tenant_id,portfolio_id,dossier_id,confidentiality,record_status,evidence_ged_ref FROM `mon-projet-data-2sg.m3s_2sg.management_dossiers` WHERE tenant_id=@tenant AND dossier_id IN UNNEST(@ids) ORDER BY dossier_id LIMIT 3',
        params: { tenant: pinned.tenantId, ids: pinned.dossiers }, location: 'US', maximumBytesBilled: '10485760' }))[0] }) };
  } catch { warn('RH_INSTITUTIONAL_CONFIGURATION_UNAVAILABLE'); return closed(); }
}
module.exports = { PREFIX, BUNDLE_ID, REFERENCE, CYCLE_ID, fileSpecs, validateRegistration, createRouter, createHost };

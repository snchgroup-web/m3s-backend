const express = require('express');
const { MAX_BYTES, readPolicy, scopeFor, approvedDocument, fail } = require('./gedPrivatePolicy');
const { createRegister } = require('./gedPrivateRegister');
const PREFIX = '/api/ged/private';
const isPrivateGedRoute = path => path.toLowerCase() === PREFIX || path.toLowerCase().startsWith(`${PREFIX}/`);
const publicRecord = row => ({ id: row.document_id, name: row.filename, size: row.byte_size, createdAt: row.created_at });
const objectKey = (scope, id) => `ged-private/v1/${scope.tenant}/${scope.owner}/${id}`;
const reference = (scope, row) => ({ key: objectKey(scope, row.document_id), generation: row.generation,
  size: row.byte_size, sha256: row.document_id });

function createGedRouter({ policy, authenticate, getServices, origins = ['https://seneswiss-group.com'] }) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  if (!policy) {
    router.use((_req, res) => res.status(503).json({ success: false, code: 'GED_NOT_ENABLED' }));
    return router;
  }
  // Authenticate before parsing any upload, independently of legacy global flags.
  router.use(authenticate);
  router.use((req, res, next) => {
    try {
      req.gedScope = scopeFor(policy, req.user);
      const origin = req.get('origin');
      if ((origin && !origins.includes(origin)) || (req.method === 'POST' && !origin)) fail('GED_ACCESS_DENIED');
      next();
    } catch { res.status(403).json({ success: false, code: 'GED_ACCESS_DENIED' }); }
  });
  let inFlight = 0;
  router.use((_req, res, next) => {
    if (inFlight >= 4) return res.status(429).json({ success: false, code: 'GED_BUSY' });
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.once('finish', release); res.once('close', release);
    next();
  });
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  router.get('/documents', handle(async (req, res) => {
    const { register } = await getServices();
    const rows = await register.list(req.gedScope);
    res.json({ success: true, documents: rows.map(publicRecord), approved: policy.documents.map(item => ({ ...item })) });
  }));
  router.post('/documents/:id', (req, res, next) => {
    try { approvedDocument(policy, req.params.id); } catch (error) { return next(error); }
    if (req.get('content-type') !== 'application/pdf' || req.get('content-encoding')) {
      return res.status(415).json({ success: false, code: 'GED_PDF_REQUIRED' });
    }
    return next();
  }, express.raw({ type: 'application/pdf', limit: MAX_BYTES, inflate: false }), handle(async (req, res) => {
    const entry = approvedDocument(policy, req.params.id, req.body);
    const { storage, register } = await getServices();
    const stored = await storage.putIfAbsent({ key: objectKey(req.gedScope, entry.sha256), bytes: req.body });
    if (stored.sha256 !== entry.sha256 || stored.size !== entry.size) fail('GED_UNAVAILABLE');
    const result = await register.create(req.gedScope, entry, stored.generation);
    // An acknowledged row is not success unless its immutable bytes are readable.
    await storage.get(reference(req.gedScope, result.row));
    res.status(result.created ? 201 : 200).json({ success: true, created: result.created, document: publicRecord(result.row) });
  }));
  router.get('/documents/:id/content', handle(async (req, res) => {
    approvedDocument(policy, req.params.id);
    const { register, storage } = await getServices();
    const row = await register.read(req.gedScope, req.params.id);
    if (!row) return res.status(404).json({ success: false, code: 'GED_NOT_FOUND' });
    const bytes = await storage.get(reference(req.gedScope, row));
    await register.auditDownload(req.gedScope, row.document_id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(bytes);
  }));
  router.use((error, _req, res, _next) => {
    const status = error?.type === 'entity.too.large' ? 413 : error?.code === 'GED_DOCUMENT_NOT_APPROVED' ? 400 : 503;
    res.status(status).json({ success: false, code: status === 413 ? 'GED_TOO_LARGE' : status === 400 ? 'GED_DOCUMENT_NOT_APPROVED' : 'GED_UNAVAILABLE' });
  });
  return router;
}

function databaseOptions(env) {
  if (typeof env.M3S_GED_DB_PASSWORD !== 'string' || env.M3S_GED_DB_PASSWORD.length < 32 ||
      typeof env.M3S_GED_DB_CA_PEM !== 'string' || !env.M3S_GED_DB_CA_PEM.includes('-----BEGIN CERTIFICATE-----')) fail('GED_DATABASE_CONFIGURATION_DENIED');
  return { host: 'postgres.railway.internal', port: 5432, database: 'railway', user: 'm3s_ged_app',
    password: env.M3S_GED_DB_PASSWORD, ssl: { ca: env.M3S_GED_DB_CA_PEM, rejectUnauthorized: true },
    max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000, statement_timeout: 10000,
    query_timeout: 12000, idle_in_transaction_session_timeout: 15000, application_name: 'm3s-ged-private' };
}

async function assertDatabaseAccess(pool) {
  const { rows } = await pool.query(`SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
    rolbypassrls, rolinherit, (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
    FROM pg_roles r WHERE rolname = current_user`);
  const role = rows[0];
  if (rows.length !== 1 || role.role !== 'm3s_ged_app' || role.memberships !== 0 ||
      ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','rolinherit'].some(key => role[key] !== false)) fail('GED_DATABASE_ROLE_DENIED');
  const rights = await pool.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
    c.relowner = (SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table,
    has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
    has_table_privilege(current_user, c.oid, 'SELECT') AS can_read,
    has_table_privilege(current_user, c.oid, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_mutate,
    has_schema_privilege(current_user, n.oid, 'CREATE') AS can_create
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='ged_private' AND c.relname IN ('documents','events') AND c.relkind='r'`);
  if (rights.rows.length !== 2 || !['documents', 'events'].every(name => rights.rows.some(row => row.relname === name)) ||
      rights.rows.some(row => row.relrowsecurity !== true || row.relforcerowsecurity !== true || row.owns_table !== false ||
        row.can_insert !== true || row.can_mutate !== false || row.can_create !== false ||
        (row.relname === 'documents' && row.can_read !== true))) fail('GED_DATABASE_ROLE_DENIED');
}

function createGedRuntime({ env, identityRuntime, credentials, dependencies = {} }) {
  let policy;
  try { policy = readPolicy(env); } catch { policy = null; }
  let ready;
  async function initialize() {
    let pool;
    try {
      const { Pool } = dependencies.pg || require('pg');
      pool = new Pool(databaseOptions(env));
      pool.on('error', () => {}); // Never emit provider errors containing connection details.
      await assertDatabaseAccess(pool);
      const { createPrivateObjectStore } = await import('./gedPrivateStorage.mjs');
      if (credentials?.client_email !== 'm3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com' || !credentials.private_key) fail('GED_STORAGE_IDENTITY_DENIED');
      const { Storage } = dependencies.storage || require('@google-cloud/storage');
      const bucket = new Storage({ credentials, projectId: 'mon-projet-data-2sg', timeout: 10000,
        retryOptions: { autoRetry: false, maxRetries: 0, totalTimeout: 15 } }).bucket('m3s-ged-prive-mon-projet-data-2sg');
      const storage = createPrivateObjectStore({ enabled: true, bucket, target: {
        bucketName: 'm3s-ged-prive-mon-projet-data-2sg', projectNumber: '39747051341', location: 'EUROPE-WEST6', maxBytes: MAX_BYTES } });
      return { register: createRegister(pool), storage };
    } catch {
      if (pool) await pool.end().catch(() => {});
      fail('GED_UNAVAILABLE');
    }
  }
  const getServices = () => {
    if (!ready) ready = initialize().catch(error => { ready = null; throw error; });
    return ready;
  };
  return createGedRouter({ policy, authenticate: identityRuntime.authenticate, getServices });
}

module.exports = { PREFIX, isPrivateGedRoute, createGedRouter, createGedRuntime, databaseOptions, assertDatabaseAccess };

const express = require('express');
const { MAX_BYTES, extensionFor, contentTypeFor, categoryFor, readPolicy, scopeFor, approvedDocument, fail } = require('./gedPrivatePolicy');
const { createRegister, validateExpenseDocumentLink } = require('./gedPrivateRegister');
const PREFIX = '/api/ged/private';
const isPrivateGedRoute = path => path.toLowerCase() === PREFIX || path.toLowerCase().startsWith(`${PREFIX}/`);
const publicRecord = (row, policy) => {
  const entry = approvedDocument(policy, row.document_id);
  return { id: row.document_id, name: row.filename, size: row.byte_size, createdAt: row.created_at,
    category: categoryFor(entry), contentType: contentTypeFor(entry), ...(row.root_id ? {
      rootId: row.root_id, title: row.title, revision: row.revision, trashed: row.trashed, lifecycle: true } : {}) };
};
const objectKey = (scope, id) => `ged-private/v1/${scope.tenant}/${scope.owner}/${id}`;
const reference = (scope, row) => ({ key: objectKey(scope, row.document_id), generation: row.generation,
  size: row.byte_size, sha256: row.document_id });

function createGedRouter({ policy, authenticate, getServices, financeRead, financeWrite, canAttachExpense, resolveExpense,
  resolveIncome,
  origins = ['https://seneswiss-group.com'] }) {
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
  async function linkedDocuments(req, spec) {
    const expense = await spec.resolve(req.params[spec.id]);
    if (!expense) fail('GED_NOT_FOUND');
    const { register } = await getServices();
    if (!register.lifecycle) fail('GED_LIFECYCLE_NOT_ENABLED');
    if (typeof register[spec.list] !== 'function') fail('GED_LIFECYCLE_NOT_ENABLED');
    const links = await register[spec.list](req.gedScope, expense.source, expense.id);
    const roots = await register.lifecycle.list(req.gedScope);
    const result = [];
    for (const link of links) {
      const root = roots.find(row => row.root_id === link.document_id);
      if (!root || root.trashed || categoryFor(approvedDocument(policy, root.root_id)) !== 'finance') continue;
      if (categoryFor(approvedDocument(policy, link.document_version_id)) !== 'finance') continue;
      const history = await register.lifecycle.history(req.gedScope, root.root_id);
      if (!history.some(event => event.current_document_id === link.document_version_id)) continue;
      const row = await register.read(req.gedScope, link.document_version_id);
      if (row) result.push({ ...publicRecord(row, policy), rootId: root.root_id,
        documentRole: link.document_role, externalReference: link.external_reference, linkRevision: link.revision });
    }
    return result;
  }
  const linkSpecs = [
    { path: 'expenses', id: 'expenseId', resolve: resolveExpense, list: 'expenseLinks', attach: 'attachExpenseDocument' },
    { path: 'income', id: 'incomeId', resolve: resolveIncome, list: 'incomeLinks', attach: 'attachIncomeDocument' }
  ];
  for (const spec of linkSpecs) {
  const route = `/${spec.path}/:${spec.id}/documents`;
  if (financeRead && spec.resolve) {
    router.get(route, financeRead, handle(async (req, res) => {
      res.json({ success: true, documents: await linkedDocuments(req, spec) });
    }));
    router.get(`${route}/:id/content`, financeRead, handle(async (req, res) => {
      const linked = (await linkedDocuments(req, spec)).find(row => row.id === req.params.id);
      if (!linked) fail('GED_NOT_FOUND');
      const { register, storage } = await getServices();
      const row = await register.read(req.gedScope, linked.id);
      const bytes = await storage.get(reference(req.gedScope, row));
      await register.auditDownload(req.gedScope, linked.id);
      const entry = approvedDocument(policy, linked.id);
      res.set({ 'Content-Type': contentTypeFor(entry), 'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="document.${extensionFor(entry)}"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox" });
      res.send(bytes);
    }));
  }
  if (financeRead && financeWrite && spec.resolve) {
    router.post(route, financeRead, financeWrite,
      express.json({ limit: 2048, strict: true }), handle(async (req, res) => {
        const candidate = validateExpenseDocumentLink(req.body);
        const expense = await spec.resolve(req.params[spec.id]);
        if (!expense) fail('GED_NOT_FOUND');
        const { register } = await getServices();
        if (!register.lifecycle || typeof register[spec.attach] !== 'function') fail('GED_LIFECYCLE_NOT_ENABLED');
        const result = await register[spec.attach](req.gedScope, expense, candidate);
        res.status(result.created ? 201 : 200).json({ success: true, ...result });
      }));
  }
  }
  router.get('/documents', handle(async (req, res) => {
    const { register } = await getServices();
    const rows = await (register.lifecycle ? register.lifecycle.list(req.gedScope) : register.list(req.gedScope));
    res.json({ success: true, documents: rows.map(row => publicRecord(row, policy)),
      approved: policy.documents.map(item => ({ ...item, category: categoryFor(item), contentType: contentTypeFor(item) })),
      capabilities: { expenseAttach: Boolean(financeRead && financeWrite && canAttachExpense?.(req) &&
        resolveExpense && register.lifecycle &&
        typeof register.attachExpenseDocument === 'function'),
        incomeAttach: Boolean(financeRead && financeWrite && canAttachExpense?.(req) &&
          resolveIncome && register.lifecycle && typeof register.attachIncomeDocument === 'function') } });
  }));
  router.get('/documents/:id/history', handle(async (req, res) => {
    const { register } = await getServices();
    if (!register.lifecycle) fail('GED_LIFECYCLE_NOT_ENABLED');
    const events = await register.lifecycle.history(req.gedScope, req.params.id);
    res.json({ success: true, history: events.map(event => ({ revision: event.revision, action: event.action,
      title: event.title, trashed: event.trashed, createdAt: event.created_at, document: publicRecord(event.row, policy) })) });
  }));
  router.post('/documents/:id/actions', express.json({ limit: 2048, strict: true }), handle(async (req, res) => {
    const { register, storage } = await getServices();
    if (!register.lifecycle) fail('GED_LIFECYCLE_NOT_ENABLED');
    if (req.body?.action === 'version') {
      approvedDocument(policy, req.body.versionId);
      const row = await register.read(req.gedScope, req.body.versionId);
      if (!row) fail('GED_NOT_FOUND');
      await storage.get(reference(req.gedScope, row));
    }
    const row = await register.lifecycle.mutate(req.gedScope, req.params.id, req.body);
    res.json({ success: true, document: publicRecord(row, policy) });
  }));
  router.post('/documents/:id', (req, res, next) => {
    let entry;
    try { entry = approvedDocument(policy, req.params.id); } catch (error) { return next(error); }
    if (req.get('content-type') !== contentTypeFor(entry) || req.get('content-encoding')) {
      return res.status(415).json({ success: false, code: 'GED_FORMAT_REQUIRED' });
    }
    return next();
  }, express.raw({ type: () => true, limit: policy.maxBytes || MAX_BYTES, inflate: false }), handle(async (req, res) => {
    const entry = approvedDocument(policy, req.params.id, req.body);
    const { storage, register } = await getServices();
    const stored = await storage.putIfAbsent({ key: objectKey(req.gedScope, entry.sha256), bytes: req.body });
    if (stored.sha256 !== entry.sha256 || stored.size !== entry.size) fail('GED_UNAVAILABLE');
    const result = await register.create(req.gedScope, entry, stored.generation);
    // An acknowledged row is not success unless its immutable bytes are readable.
    await storage.get(reference(req.gedScope, result.row));
    res.status(result.created ? 201 : 200).json({ success: true, created: result.created, document: publicRecord(result.row, policy) });
  }));
  router.get('/documents/:id/content', handle(async (req, res) => {
    const entry = approvedDocument(policy, req.params.id);
    const { register, storage } = await getServices();
    const row = await register.read(req.gedScope, req.params.id);
    if (!row) return res.status(404).json({ success: false, code: 'GED_NOT_FOUND' });
    const bytes = await storage.get(reference(req.gedScope, row));
    await register.auditDownload(req.gedScope, row.document_id);
    res.set({ 'Content-Type': contentTypeFor(entry), 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="document.${extensionFor(entry)}"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(bytes);
  }));
  router.use((error, _req, res, _next) => {
    const lifecycleStatus = { GED_VERSION_CONFLICT: 409, GED_INVALID_COMMAND: 400, GED_INVALID_TITLE: 400,
      GED_DOCUMENT_TRASHED: 409, GED_DOCUMENT_NOT_TRASHED: 409, GED_REVISION_LIMIT: 409, GED_VERSION_NOT_APPROVED: 400,
      GED_VERSION_ALREADY_LINKED: 409, GED_VERSION_NOT_ROOT: 409, GED_NOT_FOUND: 404, GED_LIFECYCLE_NOT_ENABLED: 503 }[error?.code];
    if (lifecycleStatus) return res.status(lifecycleStatus).json({ success: false, code: error.code });
    const malformedJson = error?.type === 'entity.parse.failed';
    const status = error?.type === 'entity.too.large' ? 413 :
      malformedJson || error?.code === 'GED_DOCUMENT_NOT_APPROVED' ? 400 : 503;
    res.status(status).json({ success: false, code: status === 413 ? 'GED_TOO_LARGE' :
      malformedJson ? 'GED_INVALID_COMMAND' : status === 400 ? 'GED_DOCUMENT_NOT_APPROVED' : 'GED_UNAVAILABLE' });
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

async function assertDatabaseAccess(pool, lifecycleEnabled = false, incomeLinksEnabled = false) {
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
  const lifecycleTables = lifecycleEnabled ? ['revisions'] : [];
  if (incomeLinksEnabled) {
    if (!lifecycleEnabled) fail('GED_DATABASE_ROLE_DENIED');
    lifecycleTables.push('income_document_links');
  }
  for (const table of lifecycleTables) {
    const result = await pool.query(`SELECT relrowsecurity, relforcerowsecurity,
      relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table,
      has_table_privilege(current_user, oid, 'SELECT') AS can_read,
      has_table_privilege(current_user, oid, 'INSERT') AS can_insert,
      has_table_privilege(current_user, oid, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_mutate
      FROM pg_class WHERE oid=to_regclass('ged_private.${table}')`);
    const r = result.rows[0];
    if (result.rows.length !== 1 || r.relrowsecurity !== true || r.relforcerowsecurity !== true || r.owns_table !== false ||
      r.can_read !== true || r.can_insert !== true || r.can_mutate !== false) fail('GED_DATABASE_ROLE_DENIED');
  }
}

function createGedRuntime({ env, identityRuntime, credentials, financeRead, financeWrite, canAttachExpense,
  resolveExpense, resolveIncome, dependencies = {} }) {
  let policy;
  try { policy = readPolicy(env); } catch { policy = null; }
  let ready;
  async function initialize() {
    let pool;
    try {
      const { Pool } = dependencies.pg || require('pg');
      pool = new Pool(databaseOptions(env));
      pool.on('error', () => {}); // Never emit provider errors containing connection details.
      const lifecycleEnabled = env.M3S_GED_LIFECYCLE_ENABLED === 'true';
      const incomeLinksEnabled = env.M3S_GED_INCOME_LINKS_ENABLED === 'true';
      await assertDatabaseAccess(pool, lifecycleEnabled, incomeLinksEnabled);
      const { createPrivateObjectStore } = await import('./gedPrivateStorage.mjs');
      if (credentials?.client_email !== 'm3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com' || !credentials.private_key) fail('GED_STORAGE_IDENTITY_DENIED');
      const { Storage } = dependencies.storage || require('@google-cloud/storage');
      const bucket = new Storage({ credentials, projectId: 'mon-projet-data-2sg', timeout: 10000,
        retryOptions: { autoRetry: false, maxRetries: 0, totalTimeout: 15 } }).bucket('m3s-ged-prive-mon-projet-data-2sg');
      const storage = createPrivateObjectStore({ enabled: true, bucket, target: {
        bucketName: 'm3s-ged-prive-mon-projet-data-2sg', projectNumber: '39747051341', location: 'EUROPE-WEST6', maxBytes: policy.maxBytes || MAX_BYTES } });
      return { register: createRegister(pool, { maxBytes: policy.maxBytes, lifecyclePolicy: lifecycleEnabled ? policy : undefined, incomeLinksEnabled }), storage };
    } catch {
      if (pool) await pool.end().catch(() => {});
      fail('GED_UNAVAILABLE');
    }
  }
  const getServices = () => {
    if (!ready) ready = initialize().catch(error => { ready = null; throw error; });
    return ready;
  };
  return createGedRouter({ policy, authenticate: identityRuntime.authenticate, getServices,
    financeRead, financeWrite, canAttachExpense, resolveExpense,
    resolveIncome: env.M3S_GED_INCOME_LINKS_ENABLED === 'true' ? resolveIncome : undefined });
}

module.exports = { PREFIX, isPrivateGedRoute, createGedRouter, createGedRuntime, databaseOptions, assertDatabaseAccess };

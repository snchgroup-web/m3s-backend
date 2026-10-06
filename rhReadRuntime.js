const express = require('express');
const { createCurrentRhPolicy, scopeFor } = require('./rhReadPolicy');

const PREFIX = '/api/rh/private';
const isPrivateRhRoute = path => typeof path === 'string' &&
  (path.toLowerCase() === PREFIX || path.toLowerCase().startsWith(`${PREFIX}/`));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = code => { throw new Error(code); };
const errors = Object.freeze({ RH_ACCESS_DENIED: 403, RH_ENTITLEMENT_SOURCE_UNAVAILABLE: 503,
  RH_INVALID_PAGE: 400, RH_SERVICE_UNAVAILABLE: 503 });

function page(query) {
  if (Object.keys(query).some(key => !['limit', 'offset'].includes(key))) fail('RH_INVALID_PAGE');
  const number = (value, fallback, min, max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,5})$/.test(value)) fail('RH_INVALID_PAGE');
    const result = Number(value);
    if (result < min || result > max) fail('RH_INVALID_PAGE');
    return result;
  };
  return { limit: number(query.limit, 50, 1, 100), offset: number(query.offset, 0, 0, 100000) };
}

function publicDraft(row) {
  if (!row || typeof row.employee_id !== 'string' || !UUID.test(row.employee_id) ||
      !Number.isInteger(row.revision) || row.revision < 1 || row.revision >= 10000 ||
      row.record_status !== 'draft' || row.classification !== 'C3' ||
      typeof row.display_name !== 'string') fail('RH_SERVICE_UNAVAILABLE');
  const displayName = row.display_name.trim().normalize('NFC');
  if (!displayName || [...displayName].length > 160 || /[<>@\x00-\x1f]/.test(displayName)) fail('RH_SERVICE_UNAVAILABLE');
  const reference = value => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail('RH_SERVICE_UNAVAILABLE');
    return value;
  };
  const date = row.employment_start_date instanceof Date
    ? row.employment_start_date.toISOString().slice(0, 10) : row.employment_start_date ?? null;
  if (date !== null) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('RH_SERVICE_UNAVAILABLE');
    const parsed = new Date(`${date}T12:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('RH_SERVICE_UNAVAILABLE');
  }
  return { employeeId: row.employee_id, revision: row.revision, displayName,
    positionRef: reference(row.position_ref), siteRef: reference(row.site_ref),
    employmentStartDate: date, status: 'draft', classification: 'C3' };
}

function createRhReadRuntime({ enabled = false, qualified = false, identityRuntime,
  readBindings, getRegister, origins = ['https://seneswiss-group.com'] } = {}) {
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => {
    try { const parsed = new URL(origin); return !['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin; }
    catch { return true; }
  })) throw new Error('RH_INVALID_ORIGINS');
  const allowed = new Set(origins);
  // No environment switch may manufacture a qualified source or initialize a database.
  const ready = enabled === true && qualified === true && identityRuntime?.mode === 'google' &&
    typeof identityRuntime.authenticate === 'function' && typeof readBindings === 'function' &&
    typeof getRegister === 'function';
  const policy = ready ? createCurrentRhPolicy({ qualified: true, readBindings }) : null;
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!ready) return res.status(503).json({ code: 'RH_NOT_ENABLED' });
    const origin = req.get('Origin');
    if (origin && !allowed.has(origin)) return res.status(403).json({ code: 'RH_ORIGIN_DENIED' });
    try { Promise.resolve(identityRuntime.authenticate(req, res, next)).catch(next); }
    catch (error) { next(error); }
  });
  router.use((req, res, next) => {
    if (req.method !== 'GET') return res.status(405).set('Allow', 'GET').json({ code: 'RH_READ_ONLY' });
    next();
  });
  router.get('/access', async (req, res, next) => {
    try {
      if (Object.keys(req.query).length) fail('RH_INVALID_PAGE');
      const scope = await scopeFor(policy, req.user, 'read');
      const register = await getRegister();
      if (typeof register?.access !== 'function') fail('RH_SERVICE_UNAVAILABLE');
      const decision = await register.access(scope);
      if (!decision || Object.keys(decision).join(',') !== 'revision' ||
          typeof decision.revision !== 'string' || !/^[1-9][0-9]{0,4}$/.test(decision.revision) ||
          Number(decision.revision) > 10000) fail('RH_SERVICE_UNAVAILABLE');
      res.json({ enabled: true, qualified: true, userId: req.user.id,
        organizationId: req.user.tenantId, revision: decision.revision });
    } catch (error) { next(error); }
  });
  router.get('/employees', async (req, res, next) => {
    try {
      const scope = await scopeFor(policy, req.user, 'read');
      const pagination = page(req.query);
      const register = await getRegister();
      if (typeof register?.list !== 'function') fail('RH_SERVICE_UNAVAILABLE');
      const rows = await register.list(scope, pagination);
      if (!Array.isArray(rows) || rows.length > pagination.limit) fail('RH_SERVICE_UNAVAILABLE');
      res.json({ items: rows.map(publicDraft), ...pagination, candidate: true });
    } catch (error) { next(error); }
  });
  router.use((_req, res) => res.status(404).json({ code: 'RH_ROUTE_NOT_FOUND' }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const code = Object.hasOwn(errors, error?.message) ? error.message : 'RH_SERVICE_UNAVAILABLE';
    res.status(errors[code]).json({ code });
  });
  return router;
}

module.exports = { PREFIX, isPrivateRhRoute, createRhReadRuntime };

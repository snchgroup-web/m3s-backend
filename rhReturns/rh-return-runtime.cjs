'use strict';
const express = require('express');
const { createQualifiedReturnSessionBridge } = require('./rh-return-session-bridge.cjs');
const route = '/returns/observations';
const statuses = Object.freeze({ RH_ACCESS_DENIED: 403, RH_RETURN_OBSERVATION_DENIED: 403,
  RH_RETURN_INVALID_BATCH: 400, RH_RETURN_INVALID_FIELDS: 400, RH_RETURN_INVALID_TARGET: 400,
  RH_RETURN_INVALID_SCOPE: 400, RH_RETURN_DUPLICATE_BATCH_ITEM: 400, RH_RETURN_BATCH_TOO_LARGE: 413,
  RH_RETURN_STALE_DOSSIER: 409, RH_RETURN_REQUEST_CONFLICT: 409,
  RH_RETURN_OBSERVATION_REVISION_CONFLICT: 409, RH_RETURN_NO_NEW_HOURS: 409,
  RH_ENTITLEMENT_SOURCE_UNAVAILABLE: 503, RH_RETURN_ACCESS_SOURCE_UNAVAILABLE: 503,
  RH_RETURN_EXPECTATION_UNAVAILABLE: 503 });

// Unmounted candidate; matching POST only, preserving every existing RH route.
function createQualifiedReturnRuntime({ qualified = false, identityRuntime, readBindings,
  observeBatch, origins = ['https://seneswiss-group.com'] } = {}) {
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => {
    try { const value = new URL(origin); return value.origin !== origin || !['https:', 'http:'].includes(value.protocol); }
    catch { return true; }
  })) throw new Error('RH_RETURN_INVALID_ORIGINS');
  const ready = qualified === true && identityRuntime?.mode === 'google' &&
    typeof identityRuntime.authenticate === 'function' && typeof readBindings === 'function' && typeof observeBatch === 'function';
  const allowed = new Set(origins);
  const bridge = ready ? createQualifiedReturnSessionBridge({ qualified, readBindings, observeBatch }) : null;
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff');
    if (!ready) return res.status(503).json({ code: 'RH_RETURN_NOT_ENABLED' });
    if (!allowed.has(req.get('Origin'))) return res.status(403).json({ code: 'RH_RETURN_ORIGIN_DENIED' });
    try { Promise.resolve(identityRuntime.authenticate(req, res, next)).catch(next); }
    catch (error) { next(error); }
  });
  router.use((req, res, next) => {
    if (req.user?.authProvider !== 'google' || typeof req.user.id !== 'string' || typeof req.user.tenantId !== 'string') {
      return res.status(401).json({ code: 'ACCESS_DENIED' });
    }
    next();
  });
  router.use(express.json({ limit: '2mb', strict: true }));
  router.post(route, async (req, res, next) => {
    try {
      if (Object.keys(req.query).length || !req.body || Array.isArray(req.body) ||
          Object.keys(req.body).join(',') !== 'items') throw new Error('RH_RETURN_INVALID_FIELDS');
      const result = await bridge.observeFromServerPrincipal(req.user, req.body.items);
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') return res.status(413).json({ code: 'RH_RETURN_BATCH_TOO_LARGE' });
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ code: 'RH_RETURN_INVALID_JSON' });
    const code = Object.hasOwn(statuses, error?.message) ? error.message : 'RH_RETURN_SERVICE_UNAVAILABLE';
    res.status(statuses[code] || 503).json({ code });
  });
  return (req, res, next) => {
    if (req.method !== 'POST' || !/^\/returns\/observations\/?$/i.test(req.path)) return next();
    return router(req, res, next);
  };
}

function createSyntheticReturnRuntime({syntheticOnly=false,identityRuntime,readBindings,observeBatch,origins} = {}) {
  return createQualifiedReturnRuntime({qualified:syntheticOnly === true,identityRuntime,readBindings,observeBatch,origins});
}
module.exports = { createSyntheticReturnRuntime,createQualifiedReturnRuntime };

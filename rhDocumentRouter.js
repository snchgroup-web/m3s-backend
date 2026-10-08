'use strict';
const express = require('express');
const { qualifiedPolicy, scopeFor } = require('./rhReadPolicy');
const { validateDocumentTarget } = require('./rhDocumentLink');
const statuses = Object.freeze({ RH_ACCESS_DENIED: 403, RH_ENTITLEMENT_SOURCE_UNAVAILABLE: 503,
  RH_INVALID_ID: 400, RH_DOCUMENT_ATTACHMENT_DENIED: 403, RH_DOCUMENT_SOURCE_UNAVAILABLE: 503,
  RH_DOCUMENT_INVALID_FIELDS: 400, RH_DOCUMENT_INVALID_REVISION: 400,
  RH_DOCUMENT_INVALID_REFERENCE: 400, RH_DOCUMENT_UNSUPPORTED_PURPOSE: 422,
  RH_DOCUMENT_DOSSIER_UNAVAILABLE: 404, RH_DOCUMENT_REVISION_CONFLICT: 409,
  RH_DOCUMENT_UNAVAILABLE: 404, RH_DOCUMENT_SCOPE_MISMATCH: 403,
  RH_DOCUMENT_NOT_ELIGIBLE: 422, RH_DOCUMENT_VERSION_CONFLICT: 409 });
const fail = code => { throw new Error(code); };

function createRhRouter({ policy, authenticate, documentAttachmentQualified = false,
  getDocumentRegister, authorizeDocumentAttachment, origins = ['https://seneswiss-group.com'] } = {}) {
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => {
    try { const parsed = new URL(origin); return !['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin; }
    catch { return true; }
  })) throw new Error('RH_INVALID_ORIGINS');
  const allowed = new Set(origins);
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff');
    if (!qualifiedPolicy(policy) || typeof authenticate !== 'function' ||
        documentAttachmentQualified !== true || typeof getDocumentRegister !== 'function' ||
        typeof authorizeDocumentAttachment !== 'function') {
      return res.status(503).json({ code: 'RH_DOCUMENT_NOT_ENABLED' });
    }
    if (!allowed.has(req.get('Origin'))) return res.status(403).json({ code: 'RH_ORIGIN_DENIED' });
    try { Promise.resolve(authenticate(req, res, next)).catch(next); } catch (error) { next(error); }
  });
  router.post('/employees/:employeeId/contract-document-links', (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 'RH_AUTH_REQUIRED' });
    if (Object.keys(req.query).length) return res.status(400).json({ code: 'RH_DOCUMENT_INVALID_QUERY' });
    if (req.get('Content-Encoding')) return res.status(415).json({ code: 'RH_DOCUMENT_ENCODING_DENIED' });
    if (!req.is('application/json')) return res.status(415).json({ code: 'RH_JSON_REQUIRED' });
    next();
  }, express.json({ limit: '8kb', strict: true }), (req, res, next) => {
    Promise.resolve().then(async () => {
      const body = req.body;
      if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'documentId,dossierRevision,purpose,versionId') {
        fail('RH_DOCUMENT_INVALID_FIELDS');
      }
      const target = validateDocumentTarget({ employeeId: req.params.employeeId, ...body });
      const identity = Object.freeze({ id: req.user.id, tenantId: req.user.tenantId, authProvider: req.user.authProvider });
      const scope = await scopeFor(policy, identity, 'revise');
      const context = Object.freeze({ scope, target, identity });
      async function authorize() {
        let result;
        try { result = await authorizeDocumentAttachment(context); }
        catch { fail('RH_DOCUMENT_SOURCE_UNAVAILABLE'); }
        if (result !== true) fail('RH_DOCUMENT_ATTACHMENT_DENIED');
      }
      await authorize();
      const register = await getDocumentRegister();
      if (typeof register?.attach !== 'function') fail('RH_DOCUMENT_NOT_ENABLED');
      const current = await scopeFor(policy, identity, 'revise');
      if (current.tenant !== scope.tenant || current.owner !== scope.owner) fail('RH_ACCESS_DENIED');
      await authorize();
      const result = await register.attach(scope, target);
      if (!result || typeof result.replayed !== 'boolean' || result.localCandidate !== true ||
          result.category !== 'rh' || result.classification !== 'C3' || result.contractStatus !== 'draft_not_signable' ||
          Object.keys(target).some(field => result[field] !== target[field])) fail('RH_SERVICE_UNAVAILABLE');
      res.status(result.replayed ? 200 : 201).json({ item: { ...target, category: 'rh', classification: 'C3',
        contractStatus: 'draft_not_signable' }, replayed: result.replayed });
    }).catch(next);
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') return res.status(413).json({ code: 'RH_BODY_TOO_LARGE' });
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ code: 'RH_INVALID_JSON' });
    const code = Object.hasOwn(statuses, error?.message) ? error.message : 'RH_SERVICE_UNAVAILABLE';
    res.status(statuses[code] || 503).json({ code });
  });
  return router;
}
module.exports = { createRhRouter };

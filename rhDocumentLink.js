'use strict';

const identifier = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error('RH_INVALID_ID');
  return value.toLowerCase();
};
const { qualifiedPolicy, scopeFor } = require('./rhReadPolicy');
const HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw new Error(code); };
const active = signal => { if (signal?.aborted) fail('RH_DOCUMENT_CANCELLED'); };

function targetFor(input) {
  const fields = ['employeeId', 'dossierRevision', 'documentId', 'versionId', 'purpose'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) {
    fail('RH_DOCUMENT_INVALID_FIELDS');
  }
  const employeeId = identifier(input.employeeId);
  if (!Number.isSafeInteger(input.dossierRevision) || input.dossierRevision < 1 || input.dossierRevision >= 10000) {
    fail('RH_DOCUMENT_INVALID_REVISION');
  }
  if (![input.documentId, input.versionId].every(value => typeof value === 'string' && HASH.test(value))) {
    fail('RH_DOCUMENT_INVALID_REFERENCE');
  }
  if (input.purpose !== 'contract_draft') fail('RH_DOCUMENT_UNSUPPORTED_PURPOSE');
  return Object.freeze({ employeeId, dossierRevision: input.dossierRevision,
    documentId: input.documentId, versionId: input.versionId, purpose: input.purpose });
}

function scopedTargetFor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'scope')) {
    fail('RH_DOCUMENT_INVALID_FIELDS');
  }
  const { scope, ...targetInput } = input;
  if (!scope || Object.keys(scope).sort().join(',') !== 'owner,tenant' ||
      ![scope.tenant, scope.owner].every(value => typeof value === 'string' && HASH.test(value))) {
    fail('RH_DOCUMENT_INVALID_SCOPE');
  }
  return Object.freeze({ scope: Object.freeze({ tenant: scope.tenant, owner: scope.owner }), ...targetFor(targetInput) });
}

const targetKey = target => JSON.stringify([target.scope.tenant, target.scope.owner,
  target.employeeId, target.dossierRevision, target.documentId, target.versionId, target.purpose]);

function validateDocumentCandidate(document, request) {
  const { scope } = request;
  if (!document) fail('RH_DOCUMENT_UNAVAILABLE');
  if (document.tenant !== scope.tenant || document.owner !== scope.owner ||
      document.employeeId !== request.employeeId || document.dossierRevision !== request.dossierRevision ||
      document.documentId !== request.documentId || document.versionId !== request.versionId) {
    fail('RH_DOCUMENT_SCOPE_MISMATCH');
  }
  if (document.category !== 'rh' || document.classification !== 'C3' ||
      document.purpose !== request.purpose || document.status !== 'draft' || document.trashed !== false) {
    fail('RH_DOCUMENT_NOT_ELIGIBLE');
  }
}

function currentDocumentAuthorizer(config, permission) {
  if (config.qualified !== true) return async () => false;
  if (typeof config.readBindings !== 'function' ||
      Object.keys(config).some(key => !['qualified', 'readBindings'].includes(key))) fail('RH_DOCUMENT_INVALID_POLICY');
  const readBindings = config.readBindings;
  return async (input, { client } = {}) => {
    const target = scopedTargetFor(input);
    let keys;
    try {
      const bindings = await readBindings(target, Object.freeze({ client }));
      if (!Array.isArray(bindings) || bindings.length > 100) fail('RH_DOCUMENT_INVALID_POLICY');
      keys = new Set();
      for (const binding of bindings) {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
            Object.keys(binding).sort().join(',') !==
              'documentId,dossierRevision,employeeId,owner,permissions,purpose,tenant,versionId') {
          fail('RH_DOCUMENT_INVALID_POLICY');
        }
        const { permissions, tenant, owner, ...reference } = binding;
        if (!Array.isArray(permissions) || permissions.length !== 1 || permissions[0] !== permission) {
          fail('RH_DOCUMENT_INVALID_POLICY');
        }
        const current = scopedTargetFor({ scope: { tenant, owner }, ...reference });
        const key = targetKey(current);
        if (keys.has(key)) fail('RH_DOCUMENT_INVALID_POLICY');
        keys.add(key);
      }
    } catch { fail('RH_DOCUMENT_SOURCE_UNAVAILABLE'); }
    return keys.has(targetKey(target));
  };
}

function createCurrentDocumentAuthorizer(config = {}) {
  return currentDocumentAuthorizer(config, 'inspect');
}

function createCurrentDocumentAttachmentAuthorizer(config = {}) {
  return currentDocumentAuthorizer(config, 'attach');
}

function createCurrentDocumentOriginalAuthorizer(config = {}) {
  return currentDocumentAuthorizer(config, 'verify_original');
}

// Metadata source only; this adapter never opens a file or grants access to it.
function createCurrentDocumentMetadataResolver(config = {}) {
  const enabled = config.qualified === true;
  if (enabled && (typeof config.readMetadata !== 'function' ||
      Object.keys(config).some(key => !['qualified', 'readMetadata'].includes(key)))) {
    fail('RH_DOCUMENT_INVALID_POLICY');
  }
  const readMetadata = config.readMetadata;
  return async (input, { client } = {}) => {
    if (!enabled) fail('RH_DOCUMENT_NOT_ENABLED');
    const target = scopedTargetFor(input);
    let row;
    try { row = await readMetadata(target, Object.freeze({ client })); }
    catch { fail('RH_DOCUMENT_SOURCE_UNAVAILABLE'); }
    if (row === null || row === undefined) fail('RH_DOCUMENT_UNAVAILABLE');
    if (typeof row !== 'object' || Array.isArray(row)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
    let document;
    try {
      document = Object.freeze(Object.fromEntries(['tenant', 'owner', 'employeeId', 'dossierRevision',
        'documentId', 'versionId', 'purpose', 'category', 'classification', 'status', 'trashed']
        .map(field => [field, row[field]])));
    } catch { fail('RH_DOCUMENT_SOURCE_UNAVAILABLE'); }
    validateDocumentCandidate(document, target);
    return document;
  };
}

// Inspection only. Injected sources must be qualified by the future server host;
// the returned candidate is not an access token, download URL or stored link.
function createDocumentLinkInspector({ enabled = false, policy = null,
  authorizeDocument, resolveDossier, resolveDocument } = {}) {
  return Object.freeze({
    async inspect(principal, input, { signal } = {}) {
      active(signal);
      if (enabled !== true || !qualifiedPolicy(policy) ||
          ![authorizeDocument, resolveDossier, resolveDocument].every(value => typeof value === 'function')) {
        fail('RH_DOCUMENT_NOT_ENABLED');
      }
      const target = targetFor(input);
      const identity = Object.freeze({ id: principal?.id, tenantId: principal?.tenantId,
        authProvider: principal?.authProvider });
      const scope = await scopeFor(policy, identity, 'read');
      active(signal);
      const request = Object.freeze({ scope, ...target });
      async function source(callback, argument) {
        let result;
        try { result = await callback(argument); }
        catch { active(signal); fail('RH_DOCUMENT_SOURCE_UNAVAILABLE'); }
        active(signal);
        return result;
      }
      if (await source(authorizeDocument, request) !== true) fail('RH_DOCUMENT_ACCESS_DENIED');
      const dossier = await source(resolveDossier, Object.freeze({ scope, employeeId: target.employeeId }));
      if (!dossier) fail('RH_DOCUMENT_DOSSIER_UNAVAILABLE');
      if (dossier.tenant !== scope.tenant || dossier.owner !== scope.owner ||
          dossier.employeeId !== target.employeeId || dossier.status !== 'draft' || dossier.classification !== 'C3') {
        fail('RH_DOCUMENT_SCOPE_MISMATCH');
      }
      if (dossier.revision !== target.dossierRevision) fail('RH_DOCUMENT_REVISION_CONFLICT');
      const document = await source(resolveDocument, request);
      validateDocumentCandidate(document, request);
      // Do not reuse the initial grants after asynchronous source reads.
      const currentScope = await scopeFor(policy, identity, 'read');
      active(signal);
      if (currentScope.tenant !== scope.tenant || currentScope.owner !== scope.owner) fail('RH_DOCUMENT_ACCESS_DENIED');
      if (await source(authorizeDocument, request) !== true) fail('RH_DOCUMENT_ACCESS_DENIED');
      return Object.freeze({ ...target, candidate: true, contractStatus: 'draft_not_signable',
        persistentLinkCreated: false, productionAccessVerified: false, writes: 0 });
    }
  });
}

module.exports = { createDocumentLinkInspector, createCurrentDocumentAuthorizer,
  createCurrentDocumentAttachmentAuthorizer, createCurrentDocumentOriginalAuthorizer,
  createCurrentDocumentMetadataResolver,
  validateDocumentTarget: targetFor, validateScopedDocumentTarget: scopedTargetFor, validateDocumentCandidate };

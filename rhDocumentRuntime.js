'use strict';

const { createCurrentRhPolicy } = require('./rhReadPolicy');
const { createRhRouter } = require('./rhDocumentRouter');
const { createRhDocumentPostgresSource } = require('./rhDocumentPostgresSource.js');
const { createContractDocumentRegister } = require('./rhContractDocumentsRegister.js');
const { createCurrentDocumentAttachmentAuthorizer,
  createCurrentDocumentMetadataResolver } = require('./rhDocumentLink.js');
const { guardedAttachmentPool } = require('./rhDocumentAttachmentAccess.js');

// Attachment middleware only: the host owns the pool and the existing read routes.
function createRhDocumentAttachmentRuntime({ qualified = false, identityRuntime, pool, origins } = {}) {
  let router;
  if (qualified === true && identityRuntime?.mode === 'google' &&
      typeof identityRuntime.authenticate === 'function' && typeof pool?.connect === 'function') {
    const checkedPool = guardedAttachmentPool(pool);
    const source = createRhDocumentPostgresSource({ qualified: true, pool: checkedPool });
    const authorize = createCurrentDocumentAttachmentAuthorizer({ qualified: true,
      readBindings: source.readDocumentBindings });
    const metadata = createCurrentDocumentMetadataResolver({ qualified: true, readMetadata: source.readMetadata });
    const register = createContractDocumentRegister(checkedPool, { enabled: true,
      authorizeAttachment: ({ client, target }) => authorize(target, { client }),
      resolveDocument: ({ client, target }) => metadata(target, { client }) });
    router = createRhRouter({ origins, authenticate: identityRuntime.authenticate,
      policy: createCurrentRhPolicy({ qualified: true, readBindings: source.readBindings }),
      getRegister: () => { throw new Error('RH_SERVICE_UNAVAILABLE'); },
      documentAttachmentQualified: true, getDocumentRegister: () => register,
      authorizeDocumentAttachment: ({ scope, target }) => authorize({ scope, ...target }) });
  }
  return (req, res, next) => {
    // Never intercept dossier reads, revisions, creation or original downloads.
    if (req.method !== 'POST' || !/^\/employees\/[^/]+\/contract-document-links\/?$/i.test(req.path)) return next();
    if (!router) {
      return res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff')
        .status(503).json({ code: 'RH_DOCUMENT_NOT_ENABLED' });
    }
    return router(req, res, next);
  };
}

module.exports = { createRhDocumentAttachmentRuntime };

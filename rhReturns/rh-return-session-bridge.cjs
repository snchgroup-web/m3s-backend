'use strict';
const { createHash } = require('node:crypto');
const { createCurrentRhPolicy, scopeFor } = require('../rhReadPolicy.js');

// The principal must come from trusted middleware. This is not an authenticator or route.
function createQualifiedReturnSessionBridge({ qualified = false, readBindings, observeBatch } = {}) {
  const ready = qualified === true && typeof readBindings === 'function' && typeof observeBatch === 'function';
  const policy = ready ? createCurrentRhPolicy({ qualified: true, readBindings }) : null;
  return Object.freeze({ async observeFromServerPrincipal(principal, inputs) {
    if (!ready) throw new Error('RH_RETURN_SESSION_NOT_QUALIFIED');
    const identity = Object.freeze({ id: principal?.id, tenantId: principal?.tenantId,
      authProvider: principal?.authProvider });
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) throw new Error('RH_RETURN_INVALID_BATCH');
    // Preserve primitive source strings and exact envelope keys; the writer validates them.
    const snapshot = Object.freeze(inputs.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.values(value).some(item => item !== null && typeof item === 'object')) {
        throw new Error('RH_RETURN_INVALID_FIELDS');
      }
      return Object.freeze({ ...value });
    }));
    const scope = await scopeFor(policy, identity, 'read');
    const actor = createHash('sha256').update(identity.id).digest('hex');
    return observeBatch(Object.freeze({ ...scope, actor }), snapshot);
  } });
}

function createSyntheticReturnSessionBridge({syntheticOnly=false,readBindings,observeBatch} = {}) {
  return createQualifiedReturnSessionBridge({qualified:syntheticOnly === true,readBindings,observeBatch});
}
module.exports = { createSyntheticReturnSessionBridge,createQualifiedReturnSessionBridge };

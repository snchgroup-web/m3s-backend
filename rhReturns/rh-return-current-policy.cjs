'use strict';
const { identifier } = require('./rh-dossiers-contract.cjs');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const month = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const fields = ['tenant', 'owner', 'actor', 'employeeId', 'dossierRevision', 'period', 'kind', 'permission'];

function validDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
      !hash(value.tenant) || !hash(value.owner) || !hash(value.actor) ||
      !Number.isSafeInteger(value.dossierRevision) || value.dossierRevision < 1 ||
      !month(value.period) || !['salary', 'hours'].includes(value.kind) ||
      value.permission !== 'observe_return') return false;
  try { identifier(value.employeeId); } catch { return false; }
  return true;
}

// Candidate source adapter only: no source registration or deployed entitlement.
function createQualifiedReturnPolicy({ qualified = false, readDecisions } = {}) {
  return Object.freeze({ async authorizeObservation(context) {
    if (qualified !== true || typeof readDecisions !== 'function') return false;
    const { scope, target } = context || {};
    const lookup = { tenant: scope?.tenant, owner: scope?.owner, actor: scope?.actor,
      employeeId: target?.employeeId, dossierRevision: target?.dossierRevision,
      period: target?.period, kind: target?.kind, permission: 'observe_return' };
    if (!validDecision(lookup)) return false;
    let decisions;
    try {
      decisions = await readDecisions(Object.freeze(lookup));
      if (!Array.isArray(decisions) || decisions.length > 100 || decisions.some(value => !validDecision(value))) {
        throw new Error('invalid source');
      }
    } catch { throw new Error('RH_RETURN_DECISION_SOURCE_UNAVAILABLE'); }
    return decisions.some(value => fields.every(key => value[key] === lookup[key]));
  } });
}

function createCurrentReturnPolicy({syntheticOnly=false,readDecisions} = {}) {
  return createQualifiedReturnPolicy({qualified:syntheticOnly === true,readDecisions});
}
module.exports = { createCurrentReturnPolicy, createQualifiedReturnPolicy };

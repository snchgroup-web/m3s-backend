'use strict';

const { createHash } = require('node:crypto');
const policies = new WeakSet();
const currentSources = new WeakMap();
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f]/.test(value);

function normalizeBindings(values, allowEmpty = false) {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) || values.length > 100) throw new Error('RH_INVALID_POLICY');
  const seen = new Set();
  return values.map(binding => {
    if (!binding || Object.keys(binding).sort().join(',') !== 'organizationId,permissions,userId' ||
        !identifier(binding.userId) || !identifier(binding.organizationId) ||
        !Array.isArray(binding.permissions) || !binding.permissions.includes('read') ||
        binding.permissions.some(value => !['read', 'revise', 'create'].includes(value)) ||
        new Set(binding.permissions).size !== binding.permissions.length) throw new Error('RH_INVALID_POLICY');
    const key = JSON.stringify([binding.organizationId, binding.userId]);
    if (seen.has(key)) throw new Error('RH_INVALID_POLICY');
    seen.add(key);
    return Object.freeze({ ...binding, permissions: Object.freeze([...binding.permissions]) });
  });
}

// Fixed bindings remain available for isolated fixtures, not live revocation.
function createRhPolicy(config = {}) {
  if (config.qualified !== true) return null;
  const bindings = normalizeBindings(config.bindings);
  const policy = Object.freeze({ bindings: Object.freeze(bindings) });
  policies.add(policy);
  return policy;
}

function createCurrentRhPolicy(config = {}) {
  if (config.qualified !== true) return null;
  if (typeof config.readBindings !== 'function' ||
      Object.keys(config).some(key => !['qualified', 'readBindings'].includes(key))) throw new Error('RH_INVALID_POLICY');
  const policy = Object.freeze({ mode: 'current-source' });
  currentSources.set(policy, config.readBindings);
  return policy;
}

function qualifiedPolicy(policy) { return !!policy && (policies.has(policy) || currentSources.has(policy)); }

function bindingScope(bindings, principal, permission) {
  const binding = bindings.find(item => item.userId === principal.id && item.organizationId === principal.tenantId);
  if (!binding?.permissions.includes(permission)) throw new Error('RH_ACCESS_DENIED');
  return Object.freeze({ tenant: digest(binding.organizationId), owner: digest(binding.userId) });
}

async function currentScope(readBindings, principal, permission) {
  let bindings;
  try {
    bindings = normalizeBindings(await readBindings(Object.freeze({
      userId: principal.id, organizationId: principal.tenantId
    })), true);
  } catch { throw new Error('RH_ENTITLEMENT_SOURCE_UNAVAILABLE'); }
  return bindingScope(bindings, principal, permission);
}

function scopeFor(policy, principal, permission) {
  if (!qualifiedPolicy(policy) || principal?.authProvider !== 'google' ||
      !identifier(principal.id) || !identifier(principal.tenantId) ||
      !['read', 'revise', 'create'].includes(permission)) throw new Error('RH_ACCESS_DENIED');
  const identity = Object.freeze({ id: principal.id, tenantId: principal.tenantId });
  if (currentSources.has(policy)) return currentScope(currentSources.get(policy), identity, permission);
  return bindingScope(policy.bindings, identity, permission);
}

module.exports = { createRhPolicy, createCurrentRhPolicy, qualifiedPolicy, scopeFor };


'use strict';
const { createRhReadRuntime } = require('./rhReadRuntime');
const { databaseOptions, createRhPostgresSource } = require('./rhPostgresSource');

function createRhReadHost({ env, identityRuntime, origins, createPool = options => {
  const { Pool } = require('pg');
  return new Pool(options);
}, warn = () => {} } = {}) {
  let pool;
  const closed = () => ({ router: createRhReadRuntime({ identityRuntime, origins }),
    close: async () => {} });
  if (env?.M3S_RH_READ_PROFILE !== 'rh-read-v1' || identityRuntime?.mode !== 'google' ||
      typeof identityRuntime.authenticate !== 'function') return closed();
  try {
    pool = createPool(databaseOptions(env));
    if (typeof pool?.connect !== 'function' || typeof pool?.end !== 'function' || typeof pool?.on !== 'function') {
      throw new Error('RH_SERVICE_UNAVAILABLE');
    }
    pool.on('error', () => warn('RH_POOL_UNAVAILABLE'));
    // Every scoped query checks the live role, schema/RLS and decision; the profile alone grants nothing.
    const source = createRhPostgresSource({ pool, qualified: true });
    let closing;
    return { router: createRhReadRuntime({ enabled: true, qualified: true,
      identityRuntime, origins, ...source }), close: () => {
      closing ??= Promise.resolve().then(() => pool.end());
      return closing;
    } };
  } catch {
    if (typeof pool?.end === 'function') Promise.resolve(pool.end()).catch(() => {});
    warn('RH_CONFIGURATION_UNAVAILABLE');
    return closed();
  }
}

module.exports = { createRhReadHost };

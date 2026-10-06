'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createRhReadHost } = require('../rhReadBootstrap');

const env = { M3S_RH_READ_PROFILE: 'rh-read-v1', M3S_RH_DB_PASSWORD: 'synthetic-only-'.repeat(3),
  M3S_RH_DB_CA_PEM: '-----BEGIN CERTIFICATE-----\nsynthetic-only\n-----END CERTIFICATE-----' };
async function request(t, host) {
  t.after(() => host.close());
  const app = express(); app.use('/api/rh/private', host.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return fetch(`http://127.0.0.1:${server.address().port}/api/rh/private/access`);
}

test('closed profiles, legacy and incomplete identities allocate no database', async t => {
  for (const patch of [{ env: {} }, { env: { ...env, M3S_RH_READ_PROFILE: 'true' } },
    { identityRuntime: { mode: 'legacy' } }, { identityRuntime: { mode: 'google' } }]) {
    const host = createRhReadHost({ env, identityRuntime: { mode: 'google', authenticate: () => assert.fail() },
      createPool: () => assert.fail('Closed runtime must not allocate a pool'), ...patch });
    const response = await request(t, host);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'RH_NOT_ENABLED' });
  }
});

test('absent dedicated credential or certificate closes without GED fallback or provider details', async t => {
  for (const patch of [{ M3S_RH_DB_PASSWORD: undefined }, { M3S_RH_DB_PASSWORD: 'short' },
    { M3S_RH_DB_CA_PEM: undefined }]) {
    const warnings = [];
    const host = createRhReadHost({ env: { ...env, ...patch, M3S_GED_DB_PASSWORD: 'not-a-fallback' },
      identityRuntime: { mode: 'google', authenticate: () => assert.fail() },
      createPool: () => assert.fail(), warn: value => warnings.push(value) });
    const response = await request(t, host);
    assert.equal(response.status, 503);
    assert.deepEqual(warnings, ['RH_CONFIGURATION_UNAVAILABLE']);
  }
});

test('configured pool stays lazy and cannot read before the existing authentication succeeds', async t => {
  let selected, ended = 0, listener;
  const warnings = [];
  const host = createRhReadHost({ env,
    identityRuntime: { mode: 'google', authenticate: (_req, res) => res.status(401).json({ code: 'IDENTITY_REQUIRED' }) },
    createPool: options => {
      selected = options;
      return { connect: () => assert.fail('No SQL before authentication'),
        end: async () => { ended++; }, on: (event, callback) => { assert.equal(event, 'error'); listener = callback; } };
    }, warn: value => warnings.push(value) });
  const response = await request(t, host);
  assert.equal(response.status, 401);
  assert.equal(selected.user, 'm3s_rh_reader');
  assert.equal(selected.host, 'postgres.railway.internal');
  assert.equal(selected.ssl.rejectUnauthorized, true);
  listener(new Error('SECRET_PROVIDER_DETAIL'));
  assert.deepEqual(warnings, ['RH_POOL_UNAVAILABLE']);
  await host.close(); assert.equal(ended, 1);
});

test('SQL connection failures expose only bounded errors and grant no access marker', async t => {
  const host = createRhReadHost({ env,
    identityRuntime: { mode: 'google', authenticate: (req, _res, next) => {
      req.user = { id: 'synthetic-reader', tenantId: 'synthetic-org', authProvider: 'google' }; next();
    } }, createPool: () => ({ connect: async () => { throw new Error('SECRET_PROVIDER_DETAIL'); },
      end: async () => {}, on: () => {} }) });
  const response = await request(t, host);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'RH_ENTITLEMENT_SOURCE_UNAVAILABLE' });
});

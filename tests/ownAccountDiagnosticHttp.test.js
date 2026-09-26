const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { signJwtToken, verifyJwtToken } = require('../authConfiguration');
const { ownAccountDiagnosticNoStore, registerHistoricalOwnAccountDiagnosticRoute,
  createSanitizedOwnAccountLoader } = require('../ownAccountDiagnostic');

const secret = 'synthetic-http-diagnostic-signing-material-not-for-production';
const clock = 1800000000000;
const principal = { id: 'fixture-user', tenantId: 'fixture-org', permissions: ['account:read'] };
async function withServer(enabled, run) {
  const app = express();
  let accounts = [{ ...principal, active: true }];
  registerHistoricalOwnAccountDiagnosticRoute(app, { enabled,
    verifyToken: token => verifyJwtToken(token, { fallbackSecret: secret, now: () => clock }),
    loadAccounts: createSanitizedOwnAccountLoader(() => accounts) });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const token = signJwtToken(principal, { fallbackSecret: secret, now: () => clock });
  const request = (bearer, method = 'GET', query = '') => fetch(
    `http://127.0.0.1:${server.address().port}/api/auth/account-diagnostic${query}`,
    { method, headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
  try { await run({ request, token, setAccounts: value => { accounts = value; } }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('HTTP route is absent by default', () => withServer(undefined, async ({ request, token }) => {
  assert.equal((await request()).status, 404);
  assert.equal((await request(token)).status, 404);
}));

test('upstream authentication refusal is private when diagnostic is enabled', async () => {
  const app = express();
  app.use('/api/auth/account-diagnostic', ownAccountDiagnosticNoStore);
  app.use('/api', (_req, res) => res.status(401).json({ success: false, error: 'Authentification requise' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/account-diagnostic`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP independent authentication, own scope, no-store, current state and no writes', () =>
  withServer(true, async ({ request, token, setAccounts }) => {
    for (const bearer of [undefined, 'invalid', token + 'x']) {
      const response = await request(bearer);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(await response.json(), { success: false, error: 'ACCESS_DENIED' });
    }
    const response = await request(token, 'GET', '?id=other&tenantId=other');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { success: true, scope: 'current-account', account: {
      id: principal.id, tenantId: principal.tenantId, active: true,
      explicitPermissions: ['account:read'], effectivePermissions: ['account:read'] } });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request(token, method)).status, 404);
    setAccounts([{ ...principal, active: true, permissions: undefined }]);
    assert.equal((await request(token)).status, 409);
    setAccounts([{ ...principal, active: false }]);
    assert.equal((await request(token)).status, 401);
  }));

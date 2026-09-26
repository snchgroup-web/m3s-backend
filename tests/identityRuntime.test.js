const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityRuntime, boundedAuth } = require('../identityRuntime');
function fixture() {
  const account = { id: 'existing', tenantId: '2sg', email: 'synthetic@example.test', name: 'Test', role: 'Manager' };
  const binding = { projectId: 'synthetic-project', tenantId: null, subject: 'subject', userId: 'existing',
    organizationId: '2sg', active: true, permissions: ['finance:read'], role: 'Manager' };
  const config = { projectId: binding.projectId, authDomain: 'synthetic-project.firebaseapp.com', apiKey: `AIza${'x'.repeat(35)}`, appId: 'synthetic' };
  const claims = { sub: 'subject', uid: 'subject', aud: binding.projectId, iss: `https://securetoken.google.com/${binding.projectId}`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, auth_time: Math.floor(Date.now() / 1000),
    email_verified: true, firebase: { sign_in_second_factor: 'totp' } };
  const env = { M3S_IDENTITY_MODE: 'google', API_REQUIRE_AUTH: 'true',
    M3S_IDENTITY_BINDING_JSON: JSON.stringify(binding), M3S_FIREBASE_WEB_CONFIG_JSON: JSON.stringify(config) };
  return { account, claims, env, options: { env, getAccounts: () => [account],
    authenticateLegacy: () => assert.fail('legacy fallback'), credentials: { client_email: 'test', private_key: 'synthetic' },
    createAuth: () => ({ verifyIdToken: async (_token, revoked) => { assert.equal(revoked, true); return claims; } }) } };
}
function response() { return { status(n) { this.code = n; return this; }, set() { return this; }, json(value) { this.body = value; return this; } }; }
test('legacy bootstrap does not initialize Google', () => {
  const runtime = createIdentityRuntime({ env: {}, authenticateLegacy: () => {}, createAuth: () => assert.fail() });
  assert.deepEqual(runtime.publicConfig, { success: true, provider: 'legacy' });
});
test('bootstrap requires explicit secure mode and pinned complete configuration', () => {
  const { options } = fixture();
  for (const patch of [{ M3S_IDENTITY_MODE: 'unknown' }, { API_REQUIRE_AUTH: 'false' }, { M3S_IDENTITY_BINDING_JSON: '{}' },
    { M3S_FIREBASE_WEB_CONFIG_JSON: '{}' }]) assert.throws(() => createIdentityRuntime({ ...options, env: { ...options.env, ...patch } }));
  assert.throws(() => createIdentityRuntime({ ...options, credentials: null }));
  assert.throws(() => createIdentityRuntime({ ...options, getAccounts: () => [] }));
});
test('approved snapshot restricts historical Manager grants and whitelists public metadata', async () => {
  const { options, account } = fixture();
  const runtime = createIdentityRuntime(options);
  const req = { get: () => 'Bearer synthetic.jwt.token' };
  let next = 0;
  await runtime.authenticate(req, response(), () => next++);
  assert.equal(next, 1); assert.deepEqual(req.user.permissions, ['finance:read']);
  assert.equal(req.user.role, 'Manager'); assert.equal(req.user.authProvider, 'google');
  assert.deepEqual(Object.keys(runtime.publicConfig.firebase).sort(), ['apiKey', 'appId', 'authDomain', 'projectId']);
  account.permissions = [];
  account.financePermissions = [];
  await runtime.authenticate(req, response(), () => {});
  assert.deepEqual(req.user.permissions, []);
  account.active = false;
  const denied = response(); await runtime.authenticate(req, denied, () => assert.fail());
  assert.equal(denied.code, 401); assert.equal(req.user, undefined);
});
test('identity substitution, ambiguity and role escalation are denied', async () => {
  for (const mutate of [account => { account.id = 'other'; }, account => { account.tenantId = 'other'; }, account => { account.role = 'Admin'; }]) {
    const { options, account } = fixture(); const runtime = createIdentityRuntime(options); mutate(account);
    const denied = response(); await runtime.authenticate({ get: () => 'Bearer synthetic.jwt.token' }, denied, () => assert.fail());
    assert.equal(denied.code, 401);
  }
  const { options, account } = fixture();
  assert.throws(() => createIdentityRuntime({ ...options, getAccounts: () => [account, { ...account }] }));
});
test('provider timeout and concurrent work have bounded limits without fallback', async () => {
  let finish;
  const auth = boundedAuth({ verifyIdToken: () => new Promise(resolve => { finish = resolve; }) }, 10, 1);
  const first = auth.verifyIdToken('synthetic', true);
  await assert.rejects(auth.verifyIdToken('other', true), /IDENTITY_BUSY/);
  await assert.rejects(first, /IDENTITY_TIMEOUT/);
  await assert.rejects(auth.verifyIdToken('other', true), /IDENTITY_BUSY/);
  finish({});
});

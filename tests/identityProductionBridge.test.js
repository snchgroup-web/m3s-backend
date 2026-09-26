const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityProductionBridge } = require('../identityProductionBridge');
const { createAccessGate } = require('../identityAccessGate');
const { permissionsForUser } = require('../financeAccess');

const now = 1800000000000;
function fixture() {
  const records = {
    claims: { sub: 'synthetic-subject', uid: 'synthetic-subject',
      aud: 'synthetic-project', iss: 'https://securetoken.google.com/synthetic-project',
      exp: now / 1000 + 3600, iat: now / 1000, auth_time: now / 1000 - 60,
      email_verified: true, email: 'not-used@example.test', role: 'Admin',
      permissions: ['finance:write'], firebase: { sign_in_second_factor: 'totp' } },
    link: { projectId: 'synthetic-project', tenantId: null, subject: 'synthetic-subject',
      userId: 'synthetic-user', organizationId: 'synthetic-org', active: true,
      permissions: ['finance:read', 'finance:write'] },
    account: { id: 'synthetic-user', tenantId: 'synthetic-org', active: true,
      permissions: ['finance:read'] },
    profile: { id: 'synthetic-user', tenantId: 'synthetic-org', active: true,
      name: 'Synthetic User', email: 'synthetic@example.test', role: 'Manager',
      privateDocument: 'never-expose', passwordHash: 'never-expose' },
    legacyCalls: 0, verifies: []
  };
  const options = { mode: 'google', projectId: 'synthetic-project', now: () => now,
    authenticateLegacy: () => { records.legacyCalls++; },
    auth: { verifyIdToken: async (token, revoked) => {
      records.verifies.push({ token, revoked }); return records.claims;
    } },
    readLinks: async key => { records.lookupKey = key; return [records.link]; },
    readAccounts: async () => [records.account], loadProfile: async () => records.profile
  };
  return { records, options };
}
function response() {
  return { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function request(header = 'Bearer synthetic.jwt.token') {
  return { get: name => name === 'authorization' ? header : null,
    user: { id: 'untrusted-legacy-user', permissions: ['finance:write'] } };
}

test('legacy mode does not inspect any Google credential or activate anything', () => {
  const legacy = () => {};
  const bridge = createIdentityProductionBridge({ authenticateLegacy: legacy,
    get auth() { throw new Error('Unexpected credential read'); } });
  assert.equal(bridge.authenticate, legacy);
  let next = 0;
  bridge.guardPasswordLogin({}, response(), () => next++);
  assert.equal(next, 1);
  const res = response(); bridge.currentAccount({}, res);
  assert.equal(res.code, 404);
});

test('unknown mode and incomplete provider configuration fail at construction', () => {
  const { options } = fixture();
  for (const mode of ['GOOGLE', 'fallback', null]) {
    assert.throws(() => createIdentityProductionBridge({ ...options, mode }));
  }
  for (const key of ['auth', 'readLinks', 'readAccounts', 'loadProfile', 'projectId']) {
    assert.throws(() => createIdentityProductionBridge({ ...options, [key]: undefined }));
  }
});

test('Google mode blocks historical password login without consulting it', () => {
  const { records, options } = fixture();
  const res = response();
  createIdentityProductionBridge(options).guardPasswordLogin({}, res, () => assert.fail());
  assert.equal(res.code, 409);
  assert.equal(res.body.code, 'AUTH_PROVIDER_REQUIRED');
  assert.equal(records.legacyCalls, 0);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('verified MFA subject maps to current explicit grants without role widening', async () => {
  const { records, options } = fixture(); const req = request(); const res = response();
  let next = 0;
  await createIdentityProductionBridge(options).authenticate(req, res, () => next++);
  assert.equal(next, 1);
  assert.deepEqual(records.verifies, [{ token: 'synthetic.jwt.token', revoked: true }]);
  assert.deepEqual(records.lookupKey, { projectId: 'synthetic-project', tenantId: null, subject: 'synthetic-subject' });
  assert.deepEqual(req.user.permissions, ['finance:read']);
  assert.equal(req.user.id, 'synthetic-user');
  assert.deepEqual(permissionsForUser({ ...req.user, role: 'Manager' }), ['finance:read']);
  assert.equal(records.legacyCalls, 0);
});

test('own account response is whitelisted, no secret, no new account:read grant', async () => {
  const { options } = fixture(); const res = response();
  await createIdentityProductionBridge(options).currentAccount(request(), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.user.email, 'synthetic@example.test');
  assert.equal(res.body.user.role, 'Manager');
  assert.deepEqual(res.body.user.permissions, ['finance:read']);
  assert.equal(JSON.stringify(res.body).includes('never-expose'), false);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

for (const [name, change] of Object.entries({
  'revoked or disabled': o => { o.auth.verifyIdToken = async () => { throw new Error('secret provider detail'); }; },
  'expired': (_o, r) => { r.claims.exp = now / 1000; },
  'future issued': (_o, r) => { r.claims.iat += 1; },
  'invalid lifetime': (_o, r) => { r.claims.exp += 1; },
  'future auth': (_o, r) => { r.claims.auth_time = now / 1000 + 1; },
  'unverified email': (_o, r) => { r.claims.email_verified = false; },
  'no TOTP': (_o, r) => { r.claims.firebase = {}; },
  'wrong factor': (_o, r) => { r.claims.firebase.sign_in_second_factor = 'phone'; },
  'wrong issuer': (_o, r) => { r.claims.iss = 'https://example.test'; },
  'wrong audience': (_o, r) => { r.claims.aud = 'other'; },
  'wrong tenant': (_o, r) => { r.claims.firebase.tenant = 'other'; },
  'wrong subject': (_o, r) => { r.claims.sub = 'other'; r.claims.uid = 'other'; },
  'disabled link': (_o, r) => { r.link.active = false; },
  'disabled account': (_o, r) => { r.account.active = false; },
  'missing explicit grants': (_o, r) => { delete r.account.permissions; r.account.role = 'Manager'; },
  'wrong organization': (_o, r) => { r.account.tenantId = 'other'; },
  'ambiguous link': (o, r) => { o.readLinks = async () => [r.link, r.link]; },
  'ambiguous account': (o, r) => { o.readAccounts = async () => [r.account, r.account]; },
  'unavailable reader': o => { o.readAccounts = async () => { throw new Error('private store detail'); }; }
})) {
  test(`reject ${name}, clear prefilled principal, no legacy fallback`, async () => {
    const { records, options } = fixture(); change(options, records);
    const res = response(); const req = request();
    await createIdentityProductionBridge(options).authenticate(req, res, () => assert.fail());
    assert.equal(res.code, 401);
    assert.deepEqual(res.body, { success: false, code: 'ACCESS_DENIED' });
    assert.equal(req.user, undefined); assert.equal(records.legacyCalls, 0);
  });
}

test('malformed headers never call the provider', async () => {
  const { records, options } = fixture(); const bridge = createIdentityProductionBridge(options);
  for (const header of ['', null, 'bearer x', 'Bearer x y', 'Bearer x\n', 'Bearer ' + 'x'.repeat(8193)]) {
    const res = response(); await bridge.authenticate(request(header), res, () => assert.fail());
    assert.equal(res.code, 401);
  }
  assert.equal(records.verifies.length, 0);
});

test('revocation/current grants are checked again on each request', async () => {
  const { records, options } = fixture(); const bridge = createIdentityProductionBridge(options);
  const req = request(); await bridge.authenticate(req, response(), () => {});
  records.account.permissions = [];
  await bridge.authenticate(req, response(), () => {});
  assert.deepEqual(req.user.permissions, []);
  records.account.active = false;
  const res = response(); await bridge.authenticate(req, res, () => assert.fail());
  assert.equal(res.code, 401); assert.equal(records.verifies.length, 3);
});

test('wrong profile or failed reader cannot leak another account', async () => {
  const { records, options } = fixture(); records.profile.tenantId = 'other';
  const res = response(); await createIdentityProductionBridge(options).currentAccount(request(), res);
  assert.equal(res.code, 401);
  options.loadProfile = async () => { throw new Error('private failure'); };
  const unavailable = response();
  await createIdentityProductionBridge(options).currentAccount(request(), unavailable);
  assert.equal(unavailable.code, 401);
  assert.equal(JSON.stringify(unavailable.body).includes('private failure'), false);
});

test('optional authentication never bypasses an explicitly requested business grant', async () => {
  const { options, records } = fixture();
  const gate = createAccessGate({ ...options, resolveBindings: async () => [{
    userId: 'u', organizationId: 'org', active: true, permissions: [] }] });
  await gate('Bearer synthetic.jwt.token');
  await assert.rejects(gate('Bearer synthetic.jwt.token', 'finance:write'), /ACCESS_DENIED/);
  assert.equal(records.verifies.every(v => v.revoked === true), true);
});

test('loopback HTTP: no legacy bypass, current account works, finance write stays denied', async t => {
  const express = require('express');
  const { createFinanceAuthorizationMiddleware } = require('../financeAccess');
  const { records, options } = fixture();
  options.auth.verifyIdToken = async (token, checkRevoked) => {
    assert.equal(checkRevoked, true);
    if (token !== 'synthetic.jwt.token') throw new Error('Invalid or legacy token');
    return records.claims;
  };
  const bridge = createIdentityProductionBridge(options);
  const app = express();
  app.post('/api/auth/login', bridge.guardPasswordLogin, () => assert.fail());
  app.get('/api/auth/me', bridge.currentAccount);
  app.get('/api/finance/read', bridge.authenticate, createFinanceAuthorizationMiddleware('finance:read'),
    (_req, res) => res.json({ success: true }));
  app.post('/api/finance/write', bridge.authenticate, createFinanceAuthorizationMiddleware('finance:write'),
    () => assert.fail('Unexpected permission expansion'));
  const server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer synthetic.jwt.token' };
  const password = await fetch(`${url}/api/auth/login`, { method: 'POST' });
  assert.equal(password.status, 409);
  assert.equal(password.headers.get('Cache-Control'), 'private, no-store');
  const legacy = await fetch(`${url}/api/auth/me`, { headers: { Authorization: 'Bearer legacy.jwt.token' } });
  assert.equal(legacy.status, 401);
  const me = await fetch(`${url}/api/auth/me`, { headers });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.id, 'synthetic-user');
  assert.equal((await fetch(`${url}/api/finance/read`, { headers })).status, 200);
  assert.equal((await fetch(`${url}/api/finance/write`, { method: 'POST', headers })).status, 403);
  records.account.active = false;
  assert.equal((await fetch(`${url}/api/finance/read`, { headers })).status, 401);
  assert.equal(records.legacyCalls, 0);
});

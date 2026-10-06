const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { createIdentityRuntime } = require('../identityRuntime');
const { PREFIX, isPrivateRhRoute, createRhReadRuntime } = require('../rhReadRuntime');

function fixture() {
  const account = { id: 'synthetic-reader', tenantId: 'synthetic-org', role: 'Manager',
    name: 'Synthetic reader', email: 'reader@example.test', active: true };
  const binding = { projectId: 'synthetic-project', tenantId: null, subject: 'subject',
    userId: account.id, organizationId: account.tenantId, active: true,
    permissions: ['finance:read'], role: account.role };
  const claims = { sub: 'subject', uid: 'subject', aud: binding.projectId,
    iss: `https://securetoken.google.com/${binding.projectId}`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    auth_time: Math.floor(Date.now() / 1000), email_verified: true,
    firebase: { sign_in_second_factor: 'totp' } };
  const env = { M3S_IDENTITY_MODE: 'google', API_REQUIRE_AUTH: 'true',
    M3S_IDENTITY_BINDING_JSON: JSON.stringify(binding),
    M3S_FIREBASE_WEB_CONFIG_JSON: JSON.stringify({ projectId: binding.projectId,
      authDomain: `${binding.projectId}.firebaseapp.com`, apiKey: `AIza${'x'.repeat(35)}`, appId: 'synthetic' }) };
  const state = { permissions: ['read'], reads: 0, storeReads: 0, authCalls: 0, scopes: [],
    rows: [{ employee_id: '11111111-1111-4111-8111-111111111111', revision: 1,
      display_name: 'Synthetic employee', employment_start_date: null, position_ref: null,
      site_ref: 'SYNTHETIC-SITE', record_status: 'draft', classification: 'C3',
      private_identity: 'must-not-leak', salary: 123, contact: 'private@example.test' }] };
  const identityRuntime = createIdentityRuntime({ env, getAccounts: () => [account],
    credentials: { client_email: 'synthetic', private_key: 'synthetic-only' },
    authenticateLegacy: () => assert.fail('No legacy fallback'),
    createAuth: () => ({ verifyIdToken: async (_token, revoked) => {
      state.authCalls++; assert.equal(revoked, true); return claims;
    } }) });
  const options = { enabled: true, qualified: true, identityRuntime,
    readBindings: async key => {
      state.reads++; assert.deepEqual(key, { userId: account.id, organizationId: account.tenantId });
      return state.permissions.length ? [{ ...key, permissions: state.permissions }] : [];
    }, getRegister: async () => ({ list: async (scope, pagination) => {
      state.storeReads++; state.scopes.push(scope); state.pagination = pagination; return state.rows;
    } }) };
  return { options, state, claims, account };
}

async function withServer(t, options, run) {
  const app = express();
  // Execute the actual host parser exclusions, without starting server.js or reading .env.
  const source = readFileSync(resolve(__dirname, '../server.js'), 'utf8');
  const fragment = source.match(/const hasPrivateBody = path =>[^\n]+;\r?\napp\.use[^\n]+;\r?\napp\.use[^\n]+;/)?.[0];
  assert.ok(fragment, 'Host private-body routing must remain explicit');
  vm.runInNewContext(fragment, { app, isPrivateRhRoute,
    isPrivateGedRoute: path => path === '/api/ged/private' || path.startsWith('/api/ged/private/'),
    generalJsonBody: express.json({ limit: '50mb' }), generalFormBody: express.urlencoded({ extended: true }) });
  app.use(PREFIX, createRhReadRuntime(options));
  app.post('/synthetic-other', (req, res) => res.json(req.body));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(async (path = '/employees', init = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}${path}`, {
        ...init, headers: { Authorization: 'Bearer synthetic.jwt.token', ...init.headers }
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
    }, `http://127.0.0.1:${server.address().port}`);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('host mounts the RH runtime closed, with no entitlement or storage inferred', () => {
  const source = readFileSync(resolve(__dirname, '../server.js'), 'utf8');
  assert.ok(source.includes('app.use(RH_PREFIX, createRhReadRuntime({ identityRuntime, origins: CORS_ORIGINS }));'));
  assert.ok(source.indexOf('app.use(RH_PREFIX,') < source.indexOf('app.use(GED_PREFIX,'));
  assert.ok(source.includes('isPrivateRhRoute(req.path) ? RH_PREFIX'));
  assert.equal(isPrivateRhRoute('/api/rh/private-ish'), false);
  assert.equal(isPrivateRhRoute('/api/rh/private/employees'), true);
  assert.equal(isPrivateRhRoute('/API/RH/PRIVATE/EMPLOYEES'), true);
  assert.equal(isPrivateRhRoute(null), false);
});

test('closed/default, unqualified, incomplete and legacy modes never contact auth or storage', async t => {
  for (const patch of [{ enabled: false }, { enabled: 'true' }, { qualified: false },
    { readBindings: undefined }, { getRegister: undefined }, { identityRuntime: { mode: 'legacy' } }]) {
    const { options, state } = fixture();
    await withServer(t, { ...options, ...patch }, async request => {
      const result = await request('/employees', { method: 'POST', body: '{invalid', headers: { 'Content-Type': 'application/json' } });
      assert.equal(result.status, 503); assert.deepEqual(result.body, { code: 'RH_NOT_ENABLED' });
      assert.match(result.headers.get('Cache-Control'), /no-store/);
      assert.equal(state.reads + state.storeReads + state.authCalls, 0);
    });
  }
  await withServer(t, {}, async request => assert.equal((await request()).status, 503));
});

test('real identity bridge requires the verified second factor before reading the RH source', async t => {
  const { options, state, claims } = fixture();
  delete claims.firebase.sign_in_second_factor;
  await withServer(t, options, async request => {
    const result = await request(); assert.equal(result.status, 401);
    assert.equal(state.reads + state.storeReads, 0);
  });
});

test('qualified read uses the authenticated scope, minimizes the response and retains unknown dates', async t => {
  const { options, state } = fixture();
  await withServer(t, options, async request => {
    const result = await request('/employees?limit=10&offset=0');
    assert.equal(result.status, 200); assert.equal(state.reads, 1); assert.equal(state.storeReads, 1);
    assert.deepEqual(result.body, { items: [{ employeeId: state.rows[0].employee_id, revision: 1,
      displayName: 'Synthetic employee', positionRef: null, siteRef: 'SYNTHETIC-SITE',
      employmentStartDate: null, status: 'draft', classification: 'C3' }], limit: 10, offset: 0, candidate: true });
    assert.equal(result.text.includes('must-not-leak'), false);
    assert.equal(result.text.includes('private@example.test'), false);
    assert.equal(Object.hasOwn(result.body, 'total'), false);
    assert.match(state.scopes[0].owner, /^[a-f0-9]{64}$/);
    assert.match(state.scopes[0].tenant, /^[a-f0-9]{64}$/);
    assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  });
});

test('Manager/Finance do not grant RH, and a current withdrawal denies the next read', async t => {
  const { options, state } = fixture();
  await withServer(t, options, async request => {
    assert.equal((await request()).status, 200);
    state.permissions = [];
    const result = await request(); assert.equal(result.status, 403);
    assert.deepEqual(result.body, { code: 'RH_ACCESS_DENIED' });
    assert.equal(state.storeReads, 1); assert.equal(state.reads, 2);
    assert.equal(result.text.includes('Synthetic employee'), false);
  });
});

test('invalid origins, mutations and malformed query never reach the register', async t => {
  const { options, state } = fixture();
  await withServer(t, options, async (request, base) => {
    assert.equal((await request('/employees', { headers: { Origin: 'https://other.example.test' } })).status, 403);
    assert.equal(state.authCalls, 0);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const result = await request('/employees', { method, ...(method === 'HEAD' ? {} : {
        body: '{malformed', headers: { 'Content-Type': 'application/json' }
      }) });
      assert.equal(result.status, 405); assert.equal(result.headers.get('Allow'), 'GET');
    }
    for (const query of ['limit=101', 'offset=-1', 'owner=other', 'limit=1&limit=2']) {
      assert.equal((await request(`/employees?${query}`)).status, 400);
    }
    assert.equal(state.storeReads, 0);
    const upper = await fetch(`${base}/API/RH/PRIVATE/EMPLOYEES`, { method: 'POST',
      headers: { Authorization: 'Bearer synthetic.jwt.token', 'Content-Type': 'application/json' }, body: '{invalid' });
    assert.equal(upper.status, 405);
    assert.deepEqual(await upper.json(), { code: 'RH_READ_ONLY' });
    assert.equal(state.storeReads, 0);
    const other = await fetch(`${base}/synthetic-other`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' });
    assert.deepEqual(await other.json(), { ok: true });
  });
});

test('entitlement and database failures expose only bounded codes', async t => {
  for (const patch of [{ readBindings: async () => { throw new Error('private binding detail'); } },
    { getRegister: async () => { throw new Error('postgres://secret'); } },
    { getRegister: async () => ({ list: async () => [{ private: 'row' }] }) }]) {
    const { options } = fixture();
    await withServer(t, { ...options, ...patch }, async request => {
      const result = await request(); assert.equal(result.status, 503);
      assert.ok(['RH_ENTITLEMENT_SOURCE_UNAVAILABLE', 'RH_SERVICE_UNAVAILABLE'].includes(result.body.code));
      assert.equal(result.text.includes('secret'), false); assert.equal(result.text.includes('private binding detail'), false);
    });
  }
});

test('invalid dates and registered non-drafts are never converted to active employees', async t => {
  for (const patch of [{ employment_start_date: '2026-02-30' }, { record_status: 'active' },
    { classification: 'C2' }, { revision: 0 }, { employee_id: 1 }]) {
    const { options, state } = fixture(); Object.assign(state.rows[0], patch);
    await withServer(t, options, async request => {
      const result = await request(); assert.equal(result.status, 503);
      assert.deepEqual(result.body, { code: 'RH_SERVICE_UNAVAILABLE' });
    });
  }
});

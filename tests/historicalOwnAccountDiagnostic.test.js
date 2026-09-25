const test = require('node:test');
const assert = require('node:assert/strict');
const httpAccess = require('../ownAccountDiagnostic');
const legacy = require('../authConfiguration');

const secret = 'synthetic-diagnostic-signing-material-not-for-production';
const clock = 1800000000000;
const principal = { id: 'fixture-user', tenantId: 'fixture-org', permissions: ['account:read'], role: 'Manager' };
test('diagnostic is disabled unless explicitly enabled as a boolean', () => {
  for (const enabled of [undefined, false, 'true', 1]) {
    httpAccess.registerHistoricalOwnAccountDiagnosticRoute({ get() { assert.fail('Route registered while disabled'); } },
      { enabled, verifyToken() { assert.fail('Unexpected verification'); }, loadAccounts() { assert.fail('Unexpected read'); } });
  }
});
function fixture() {
  let handlers; let time = clock; let reads = 0;
  let accounts = [{ ...principal, active: true }];
  httpAccess.registerHistoricalOwnAccountDiagnosticRoute({ get(path, ...chain) {
    assert.equal(path, '/api/auth/account-diagnostic'); assert.equal(handlers, undefined); handlers = chain;
  } }, { enabled: true, verifyToken: token => legacy.verifyJwtToken(token, { fallbackSecret: secret, now: () => time }),
    loadAccounts: async key => { reads++; assert.deepEqual(key, { id: principal.id, tenantId: principal.tenantId }); return accounts; } });
  const token = values => legacy.signJwtToken(values || principal, { fallbackSecret: secret, now: () => clock });
  return { token, expire: () => { time += 25 * 60 * 60 * 1000; }, setAccounts: value => { accounts = value; },
    reads: () => reads, async request(header) {
      const result = { status: 200, headers: {} };
      const res = { set(k, v) { result.headers[k] = v; }, status(v) { result.status = v; return this; },
        json(v) { result.body = v; return this; } };
      const req = { get: () => header, user: principal, query: { id: 'other', tenantId: 'other' } };
      await handlers[0](req, res, () => handlers[1](req, res));
      return result;
    } };
}

test('existing JWT verifier drives a strictly own-account read without using role', async () => {
  const f = fixture(); const result = await f.request(`Bearer ${f.token()}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.account, { id: principal.id, tenantId: principal.tenantId, active: true,
    explicitPermissions: ['account:read'], effectivePermissions: ['account:read'] });
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
});
test('preexisting req.user cannot bypass a missing or invalid signature', async () => {
  const f = fixture();
  for (const header of [undefined, '', 'Bearer invalid', `Bearer ${f.token()}x`]) {
    assert.equal((await f.request(header)).status, 401);
  }
  assert.equal(f.reads(), 0);
});
test('expired historical session is refused before account lookup', async () => {
  const f = fixture(); const token = f.token(); f.expire();
  assert.equal((await f.request(`Bearer ${token}`)).status, 401); assert.equal(f.reads(), 0);
});
test('missing stable IDs never fall back to email or default organization', async () => {
  const f = fixture();
  for (const value of [{ ...principal, id: undefined, email: 'fixture@example.invalid' },
    { ...principal, tenantId: undefined }]) assert.equal((await f.request(`Bearer ${f.token(value)}`)).status, 401);
  assert.equal(f.reads(), 0);
});
test('current account deactivation is enforced despite a still-valid signature', async () => {
  const f = fixture(); const token = f.token();
  assert.equal((await f.request(`Bearer ${token}`)).status, 200);
  f.setAccounts([{ ...principal, active: false }]);
  assert.equal((await f.request(`Bearer ${token}`)).status, 401);
});
test('current rights removal is visible despite old token rights', async () => {
  const f = fixture(); f.setAccounts([{ ...principal, active: true, permissions: [] }]);
  const result = await f.request(`Bearer ${f.token()}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.account.explicitPermissions, []);
  assert.deepEqual(result.body.account.effectivePermissions, []);
});

test('historical loader selects only exact IDs and never reads credential fields', async () => {
  const own = { ...principal, active: true };
  const other = { id: 'other', tenantId: principal.tenantId };
  for (const field of ['passwordHash', 'passwordSalt', 'password', 'email', 'role']) {
    Object.defineProperty(own, field, { configurable: true, get() { assert.fail(`Forbidden read ${field}`); } });
  }
  Object.defineProperty(other, 'permissions', { get() { assert.fail('Other account permissions read'); } });
  const load = httpAccess.createSanitizedOwnAccountLoader(() => [other, own]);
  assert.deepEqual(await load({ id: principal.id, tenantId: principal.tenantId }), [{
    id: principal.id, tenantId: principal.tenantId, active: true, permissions: ['account:read'] }]);
});
test('loader preserves duplicates for rejection and does not invent missing explicit grants', async () => {
  const own = { id: principal.id, tenantId: principal.tenantId, active: true, role: 'Manager' };
  const load = httpAccess.createSanitizedOwnAccountLoader(() => [own, own]);
  const result = await load(own);
  assert.equal(result.length, 2); assert.equal(result[0].permissions, null);
});

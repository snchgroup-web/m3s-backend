const test = require('node:test');
const assert = require('node:assert/strict');
const httpAccess = require('../ownAccountDiagnostic');

const user = { id: 'fixture-user', tenantId: 'fixture-org', permissions: ['account:read'] };
const account = () => ({ ...user, active: true, permissions: ['account:read', 'admin:write'] });
async function run(loadAccounts, principal = user) {
  let handler;
  httpAccess.registerOwnAccountDiagnosticRoute({ get(route, middleware, last) {
    assert.equal(route, '/api/auth/account-diagnostic'); assert.equal(middleware, 'AUTHENTICATED'); handler = last;
  } }, { authenticate(permission) { assert.equal(permission, 'account:read'); return 'AUTHENTICATED'; }, loadAccounts });
  const result = { status: 200, headers: {} };
  const res = { set(name, value) { result.headers[name] = value; },
    status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; } };
  await handler({ user: principal, query: { id: 'other', tenantId: 'other' }, body: { id: 'other' } }, res);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  return result;
}

test('own diagnostic ignores selectors and does not read secrets or HR data', async () => {
  const a = account();
  for (const field of ['email', 'role', 'passwordHash', 'password', 'salary', 'documents']) {
    Object.defineProperty(a, field, { enumerable: true, get() { assert.fail(`Forbidden read ${field}`); } });
  }
  const result = await run(async key => {
    assert.deepEqual(key, { id: user.id, tenantId: user.tenantId });
    return [a];
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { success: true, scope: 'current-account', account: {
    id: user.id, tenantId: user.tenantId, active: true,
    explicitPermissions: ['account:read', 'admin:write'], effectivePermissions: ['account:read'] } });
});

for (const [name, records] of [
  ['missing', []], ['ambiguous', [account(), account()]], ['bad shape', null],
  ['other person', [{ ...account(), id: 'other' }]],
  ['other organization', [{ ...account(), tenantId: 'other' }]],
  ['inactive', [{ ...account(), active: false }]]
]) test(`diagnostic refuses ${name}`, async () => {
  const result = await run(async () => records);
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { success: false, error: 'ACCESS_DENIED' });
});

test('role-only account is explicitly incomplete, not promoted to administrator', async () => {
  const result = await run(async () => [{ ...account(), permissions: undefined, role: 'Manager' }]);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'EXPLICIT_PERMISSIONS_UNAVAILABLE');
});
test('repository error is neutral', async () => {
  const result = await run(async () => { throw new Error('PRIVATE_DETAIL'); });
  assert.equal(result.status, 503); assert.equal(result.body.error, 'ACCOUNT_UNAVAILABLE');
});
test('missing principal is refused without reading a repository', async () => {
  const result = await run(async () => assert.fail('Unexpected read'), null);
  assert.equal(result.status, 401);
});

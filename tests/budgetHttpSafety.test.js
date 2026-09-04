const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, runHttp, main } = require('../scripts/testBudgetHttp');

const url = 'https://budget-preview.example.test/api';
const args = ['--execute', '--non-production', '--url', url, '--confirm', url];
const env = {
  BUDGET_HTTP_OWNER_EMAIL: 'owner@example.test', BUDGET_HTTP_OWNER_PASSWORD: 'secret-owner',
  BUDGET_HTTP_OTHER_OWNER_EMAIL: 'peer@example.test', BUDGET_HTTP_OTHER_OWNER_PASSWORD: 'secret-peer',
  BUDGET_HTTP_OTHER_TENANT_EMAIL: 'tenant@example.test', BUDGET_HTTP_OTHER_TENANT_PASSWORD: 'secret-tenant'
};

function response(status, payload, cache = '') {
  return { status, headers: { get: key => key.toLowerCase() === 'cache-control' ? cache : '' },
    async json() { return payload; } };
}

function fixture() {
  const requests = []; const tokens = new Map([
    [env.BUDGET_HTTP_OWNER_EMAIL, 'token-owner-12345678901234567890'],
    [env.BUDGET_HTTP_OTHER_OWNER_EMAIL, 'token-peer-123456789012345678901'],
    [env.BUDGET_HTTP_OTHER_TENANT_EMAIL, 'token-tenant-123456789012345678']
  ]);
  const id = '123e4567-e89b-42d3-a456-426614174000'; let stored; let version = 0;
  const fetchImpl = async (requestUrl, options) => {
    const parsed = new URL(requestUrl); const path = parsed.pathname.replace('/api', '');
    const auth = options.headers?.Authorization?.replace('Bearer ', '');
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, method: options.method, auth: Boolean(auth), body: Boolean(body) });
    if (path === '/auth/login') {
      const token = tokens.get(body.email);
      return response(token && body.password === env[body.email === env.BUDGET_HTTP_OWNER_EMAIL
        ? 'BUDGET_HTTP_OWNER_PASSWORD' : body.email === env.BUDGET_HTTP_OTHER_OWNER_EMAIL
          ? 'BUDGET_HTTP_OTHER_OWNER_PASSWORD' : 'BUDGET_HTTP_OTHER_TENANT_PASSWORD']
        ? 200 : 401, token ? { success: true, token } : { success: false });
    }
    if (!auth) return response(401, { success: false }, 'no-store');
    if (path === '/finance/budget-drafts/capabilities') return response(200,
      { success: true, enabled: true, canWrite: true, scope: 'organization', access: 'owner-only' }, 'no-store');
    if (path === '/finance/budget-drafts' && options.method === 'POST') {
      stored = body.budget; version = 1; return response(201, { success: true, data: { id, version } }, 'no-store');
    }
    if (path === `/finance/budget-drafts/${id}` && options.method === 'GET') {
      if (auth !== tokens.get(env.BUDGET_HTTP_OWNER_EMAIL)) return response(404, { success: false }, 'no-store');
      return response(200, { success: true, data: { id, version, budget: stored } }, 'no-store');
    }
    if (path === `/finance/budget-drafts/${id}` && options.method === 'PUT') {
      if (body.expectedVersion !== version) return response(409, { success: false }, 'no-store');
      stored = body.budget; version++; return response(200, { success: true, data: { id, version } }, 'no-store');
    }
    throw new Error('Unexpected request');
  };
  return { fetchImpl, requests };
}

test('plan performs no network access', async () => {
  const logs = [];
  assert.equal(await main([], { env: {}, log: value => logs.push(value),
    fetchImpl() { assert.fail('Plan attempted network access'); } }), 0);
  assert.equal(logs[0].networkAccess, false);
});

for (const [name, candidate] of Object.entries({
  production: ['--execute', '--non-production', '--url', 'https://web-production-1e53c.up.railway.app/api',
    '--confirm', 'https://web-production-1e53c.up.railway.app/api'],
  noAttestation: ['--execute', '--url', url, '--confirm', url],
  wrongConfirmation: ['--execute', '--non-production', '--url', url, '--confirm', 'https://other.test/api'],
  insecure: ['--execute', '--non-production', '--url', 'http://preview.example.test/api',
    '--confirm', 'http://preview.example.test/api'],
  query: ['--execute', '--non-production', '--url', `${url}?token=x`, '--confirm', `${url}?token=x`],
  missingCredentials: args
})) test(`refuses ${name} before network access`, async () => {
  const logs = [];
  const code = await main(candidate, { env: name === 'missingCredentials' ? {} : env,
    log: value => logs.push(value), fetchImpl() { assert.fail('Unsafe network access'); } });
  assert.equal(code, 1); assert.equal(logs.at(-1).status, 'refused');
  assert.doesNotMatch(JSON.stringify(logs), /secret-owner|secret-peer|secret-tenant/);
});

test('direct runner retains exact target confirmation at its execution boundary', async () => {
  const fake = fixture();
  await assert.rejects(runHttp({ ...parseArgs(args, env), confirmation: 'https://other.test/api' },
    { env, fetchImpl: fake.fetchImpl }), /EXACT_TARGET_CONFIRMATION_REQUIRED/);
  assert.equal(fake.requests.length, 0);
});

test('authenticated recipe proves JWT, owner and tenant isolation, and stale-version handling', async () => {
  const fake = fixture(); const passed = [];
  const report = await runHttp(parseArgs(args, env), { env, fetchImpl: fake.fetchImpl,
    log: row => passed.push(row.passed) });
  assert.equal(report.status, 'passed', JSON.stringify(report));
  assert.deepEqual(passed, report.checks); assert.equal(report.checks.length, 7);
  assert.equal(fake.requests.filter(request => request.path === '/auth/login').length, 3);
  assert.doesNotMatch(JSON.stringify(report), /secret-|token-/);
});

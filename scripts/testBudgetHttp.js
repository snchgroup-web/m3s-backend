const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const PRODUCTION_HOSTS = new Set([
  'web-production-1e53c.up.railway.app',
  'seneswiss-group.com',
  'www.seneswiss-group.com'
]);
const CREDENTIAL_KEYS = [
  'BUDGET_HTTP_OWNER_EMAIL',
  'BUDGET_HTTP_OWNER_PASSWORD',
  'BUDGET_HTTP_OTHER_OWNER_EMAIL',
  'BUDGET_HTTP_OTHER_OWNER_PASSWORD',
  'BUDGET_HTTP_OTHER_TENANT_EMAIL',
  'BUDGET_HTTP_OTHER_TENANT_PASSWORD'
];
const checks = ['unauthenticated', 'jwt-login', 'capabilities', 'round-trip',
  'owner-isolation', 'tenant-isolation', 'stale-version'];
const refusal = code => { const error = new Error(code); error.safeCode = code; throw error; };

function normalizeUrl(value) {
  let url;
  try { url = new URL(value); } catch { refusal('INVALID_TEST_URL'); }
  if (url.username || url.password || url.search || url.hash) refusal('INVALID_TEST_URL');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) refusal('HTTPS_TEST_URL_REQUIRED');
  if (PRODUCTION_HOSTS.has(url.hostname.toLowerCase())) refusal('PRODUCTION_TARGET_FORBIDDEN');
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/api')) refusal('API_BASE_URL_REQUIRED');
  return `${url.origin}${path}`;
}

function parseArgs(args, env = {}) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--plan', '--execute', '--non-production', '--url', '--confirm'].includes(key)
      || Object.hasOwn(flags, key)) refusal('INVALID_ARGUMENTS');
    if (['--plan', '--execute', '--non-production'].includes(key)) flags[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) refusal('MISSING_ARGUMENT_VALUE');
      flags[key] = value;
    }
  }
  if (flags['--plan'] && flags['--execute']) refusal('CONFLICTING_MODES');
  const execute = flags['--execute'] === true;
  const baseUrl = flags['--url'] ? normalizeUrl(flags['--url']) : null;
  if (execute && !baseUrl) refusal('TEST_URL_REQUIRED');
  if (execute && flags['--non-production'] !== true) refusal('NON_PRODUCTION_ATTESTATION_REQUIRED');
  if (execute && flags['--confirm'] !== baseUrl) refusal('EXACT_TARGET_CONFIRMATION_REQUIRED');
  if (!execute && (flags['--confirm'] || flags['--non-production'])) refusal('EXECUTION_FLAGS_REQUIRE_EXECUTE');
  if (execute && CREDENTIAL_KEYS.some(key => typeof env[key] !== 'string' || !env[key])) {
    refusal('THREE_TEST_ACCOUNTS_REQUIRED');
  }
  return { execute, baseUrl, confirmation: flags['--confirm'] };
}

const syntheticBudget = runId => ({
  title: `Synthetic HTTP acceptance ${runId}`,
  entity: 'SYNTHETIC TEST ONLY',
  year: '2026',
  revision: 0,
  rate: '710',
  rateSource: 'Synthetic assumption, not a market rate',
  rateDate: '2026-01-01',
  rows: [{ id: 'synthetic-http-line', label: 'Synthetic forecast', kind: 'operating',
    direction: 'out', currency: 'CHF', months: ['0', '12.50', ...Array(10).fill('')] }]
});

function account(env, prefix) {
  return { email: env[`BUDGET_HTTP_${prefix}_EMAIL`], password: env[`BUDGET_HTTP_${prefix}_PASSWORD`] };
}

async function runHttp(config, { env = process.env, fetchImpl = global.fetch, log = () => {} } = {}) {
  if (!config.execute) refusal('EXECUTION_REQUIRED');
  config = parseArgs(['--execute', '--non-production', '--url', config.baseUrl,
    '--confirm', config.confirmation], env);
  if (typeof fetchImpl !== 'function') refusal('FETCH_UNAVAILABLE');
  const report = { mode: 'http-jwt', status: 'running', target: config.baseUrl,
    runId: crypto.randomUUID(), checks: [], stage: 'setup',
    limits: ['Synthetic non-production data only.', 'No production activation or IAM mutation.',
      'Three pre-provisioned test accounts required; credentials and tokens are never logged.',
      'Created test drafts are retained for audit because the API has no delete route.'] };
  const call = async (path, { method = 'GET', token, body } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(`${config.baseUrl}${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      let payload;
      try { payload = await response.json(); } catch { refusal('INVALID_API_RESPONSE'); }
      return { status: response.status, payload, cache: response.headers?.get?.('cache-control') || '' };
    } finally { clearTimeout(timeout); }
  };
  const run = async (name, fn) => { report.stage = name; await fn(); report.checks.push(name); log({ passed: name }); };
  const login = async credentials => {
    const response = await call('/auth/login', { method: 'POST', body: credentials });
    assert.equal(response.status, 200);
    assert.equal(response.payload?.success, true);
    assert.equal(typeof response.payload?.token, 'string');
    assert(response.payload.token.length > 20);
    return response.payload.token;
  };
  try {
    let ownerToken; let otherOwnerToken; let otherTenantToken; let draftId; let budget;
    await run('unauthenticated', async () => {
      const response = await call('/finance/budget-drafts/capabilities');
      assert.equal(response.status, 401);
    });
    await run('jwt-login', async () => {
      [ownerToken, otherOwnerToken, otherTenantToken] = await Promise.all([
        login(account(env, 'OWNER')),
        login(account(env, 'OTHER_OWNER')),
        login(account(env, 'OTHER_TENANT'))
      ]);
      assert.equal(new Set([ownerToken, otherOwnerToken, otherTenantToken]).size, 3);
    });
    await run('capabilities', async () => {
      const response = await call('/finance/budget-drafts/capabilities', { token: ownerToken });
      assert.equal(response.status, 200);
      assert.equal(response.cache.toLowerCase(), 'no-store');
      assert.deepEqual({ enabled: response.payload?.enabled, canWrite: response.payload?.canWrite,
        scope: response.payload?.scope, access: response.payload?.access },
      { enabled: true, canWrite: true, scope: 'organization', access: 'owner-only' });
    });
    await run('round-trip', async () => {
      budget = syntheticBudget(report.runId);
      const created = await call('/finance/budget-drafts', { method: 'POST', token: ownerToken, body: { budget } });
      assert.equal(created.status, 201); assert.equal(created.cache.toLowerCase(), 'no-store');
      draftId = created.payload?.data?.id; assert.match(draftId || '', /^[0-9a-f-]{36}$/i);
      const loaded = await call(`/finance/budget-drafts/${draftId}`, { token: ownerToken });
      assert.equal(loaded.status, 200); assert.equal(loaded.cache.toLowerCase(), 'no-store');
      assert.equal(loaded.payload?.data?.version, 1); assert.deepEqual(loaded.payload?.data?.budget, budget);
    });
    await run('owner-isolation', async () => {
      const response = await call(`/finance/budget-drafts/${draftId}`, { token: otherOwnerToken });
      assert.equal(response.status, 404); assert.equal(response.cache.toLowerCase(), 'no-store');
    });
    await run('tenant-isolation', async () => {
      const response = await call(`/finance/budget-drafts/${draftId}`, { token: otherTenantToken });
      assert.equal(response.status, 404); assert.equal(response.cache.toLowerCase(), 'no-store');
    });
    await run('stale-version', async () => {
      const changed = { ...budget, title: `${budget.title} updated` };
      const saved = await call(`/finance/budget-drafts/${draftId}`, { method: 'PUT', token: ownerToken,
        body: { budget: changed, expectedVersion: 1 } });
      assert.equal(saved.status, 200); assert.equal(saved.payload?.data?.version, 2);
      const stale = await call(`/finance/budget-drafts/${draftId}`, { method: 'PUT', token: ownerToken,
        body: { budget, expectedVersion: 1 } });
      assert.equal(stale.status, 409);
    });
    report.status = 'passed'; report.stage = 'complete';
  } catch (error) {
    report.status = 'failed'; report.reason = error.safeCode || 'CHECK_FAILED';
  }
  return report;
}

async function main(args = process.argv.slice(2), { env = process.env,
  fetchImpl = global.fetch, log = value => console.log(JSON.stringify(value)) } = {}) {
  try {
    const config = parseArgs(args, env);
    if (!config.execute) {
      log({ mode: 'plan', networkAccess: false, executionAuthorized: false, target: config.baseUrl,
        checks, requires: ['Dedicated non-production backend with Budget storage enabled.',
          'Three test accounts: owner, another owner in the same tenant, and another tenant.',
          'Credentials only through BUDGET_HTTP_* environment variables.',
          'Exact URL confirmation plus --non-production; known production hosts are refused.'] });
      return 0;
    }
    const report = await runHttp(config, { env, fetchImpl, log });
    log(report); return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    log({ status: 'refused', reason: error.safeCode || 'SETUP_FAILED' }); return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { normalizeUrl, parseArgs, syntheticBudget, runHttp, main, checks };

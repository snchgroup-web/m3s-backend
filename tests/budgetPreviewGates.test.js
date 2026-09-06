const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const transitions = require('../scripts/testBudgetPreviewTransitions');
const logs = require('../scripts/analyzeBudgetPreviewLogs');

const primary = 'https://preview-a.example.test/api';
const secondary = 'https://preview-b.example.test/api';

test('preview transition plan is offline and execution requires two exact non-production targets', async () => {
  let fetched = false;
  const output = [];
  assert.equal(await transitions.main([], {
    env: {}, fetchImpl() { fetched = true; }, log: value => output.push(value)
  }), 0);
  assert.equal(fetched, false);
  assert.equal(output[0].networkAccess, false);
  assert.throws(() => transitions.parseArgs(['--execute', '--primary-url', primary,
    '--secondary-url', secondary], {}), /NON_PRODUCTION_ATTESTATION_REQUIRED/);
  assert.throws(() => transitions.parseArgs(['--execute', '--non-production',
    '--primary-url', primary, '--secondary-url', secondary, '--confirm', `${primary}|wrong`], {}),
  /EXACT_TARGET_CONFIRMATION_REQUIRED/);
  const env = { BUDGET_HTTP_OWNER_EMAIL: 'owner@example.test',
    BUDGET_HTTP_OWNER_PASSWORD: 'synthetic-only' };
  assert.deepEqual(transitions.parseArgs(['--execute', '--non-production',
    '--primary-url', primary, '--secondary-url', secondary,
    '--confirm', `${primary}|${secondary}`], env), {
    execute: true, primaryUrl: primary, secondaryUrl: secondary,
    confirmation: `${primary}|${secondary}`
  });
  await assert.rejects(() => transitions.runPreviewTransitions({
    execute: true, primaryUrl: 'https://seneswiss-group.com/api',
    secondaryUrl: secondary, confirmation: `https://seneswiss-group.com/api|${secondary}`
  }, { env, fetchImpl() { fetched = true; }, prompt: async () => '' }),
  /PRODUCTION_TARGET_FORBIDDEN/);
  assert.equal(fetched, false);
});

test('token headers and p95 are derived without exposing token contents', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'preview-old' }))
    .toString('base64url');
  assert.equal(transitions.tokenHeader(`${header}.payload.signature`).kid, 'preview-old');
  assert.equal(transitions.percentile95([10, 20, 30, 40, 500]), 500);
});

test('preview transition runner preserves tokens across all six operator gates', async () => {
  const token = kid => {
    const value = kid ? { alg: 'HS256', typ: 'JWT', kid } : { alg: 'HS256', typ: 'JWT' };
    return `${Buffer.from(JSON.stringify(value)).toString('base64url')}.payload.signature`;
  };
  const legacy = token();
  const old = token('preview-old');
  const current = token('preview-new');
  let phase = 'LEGACY_BASELINE';
  const prompts = [];
  const response = (status, payload = {}) => ({ status, async json() { return payload; } });
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const authorization = options.headers?.Authorization || '';
    const bearer = authorization.replace(/^Bearer /, '');
    if (path.endsWith('/health')) return response(200, { status: 'ok' });
    if (path.endsWith('/auth/login')) {
      if (phase === 'LEGACY_BASELINE') {
        return response(200, { success: true, token: legacy });
      }
      if (['PRIMARY_SHARED', 'SECONDARY_SHARED'].includes(phase)) {
        return response(200, { success: true, token: old });
      }
      return response(200, { success: true, token: current });
    }
    if (path.endsWith('/capabilities')) {
      if (phase === 'OWNER_DISABLED_BOTH') return response(401);
      if (phase === 'OLD_REMOVED_BOTH' && [legacy, old].includes(bearer)) return response(401);
      return response(200, { canWrite: phase !== 'WRITE_REMOVED_BOTH' });
    }
    if (path.endsWith('/budget-drafts') && options.method === 'POST'
      && phase === 'WRITE_REMOVED_BOTH') return response(403);
    throw new Error(`Unexpected request ${options.method || 'GET'} ${path}`);
  };
  const config = { execute: true, primaryUrl: primary, secondaryUrl: secondary,
    confirmation: `${primary}|${secondary}` };
  const report = await transitions.runPreviewTransitions(config, {
    env: { BUDGET_HTTP_OWNER_EMAIL: 'owner@example.test',
      BUDGET_HTTP_OWNER_PASSWORD: 'synthetic-only' },
    fetchImpl,
    prompt: async question => {
      const next = transitions.PHASES[prompts.length];
      assert.match(question, new RegExp(next));
      prompts.push(next);
      phase = next;
      return `CONFIRM ${next}`;
    },
    sleep: async () => {},
    samples: transitions.OBSERVATION_SAMPLES,
    intervalMs: transitions.OBSERVATION_INTERVAL_MS
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(prompts, transitions.PHASES);
  assert.deepEqual(report.phases, ['LEGACY_BASELINE', ...transitions.PHASES]);
  assert.equal(JSON.stringify(report).includes('signature'), false);
});

test('HTTP log analyzer enforces 5xx, 409 and latency thresholds', () => {
  const passed = logs.analyzeHttp([
    ...Array.from({ length: 20 }, (_, index) => ({
      httpStatus: 200, totalDuration: 100 + index, path: '/api/health'
    })),
    { httpStatus: 409, totalDuration: 120, path: '/api/finance/budget-drafts/:id' }
  ], 1);
  assert.equal(passed.status, 'passed');
  const stopped = logs.analyzeHttp(Array.from({ length: 20 }, () => ({
    httpStatus: 500, totalDuration: 3100, path: '/api/health'
  })), 0);
  assert.equal(stopped.status, 'stop');
  assert.deepEqual(stopped.stopReasons, [
    'HTTP_5XX', 'HEALTH_UNAVAILABLE', 'HTTP_P95_THRESHOLD', 'HTTP_MAX_THRESHOLD'
  ]);
  const unavailable = logs.analyzeHttp(Array.from({ length: 20 }, () => ({
    httpStatus: 404, totalDuration: 20, path: '/api/health'
  })), 0);
  assert.deepEqual(unavailable.stopReasons, ['HEALTH_UNAVAILABLE']);
  const crossRoute5xx = logs.analyzeHttp([
    ...Array.from({ length: 20 }, () => ({
      httpStatus: 200, totalDuration: 20, path: '/api/health'
    })),
    { httpStatus: 503, totalDuration: 5, path: '/api/auth/login' }
  ], 0);
  assert.equal(crossRoute5xx.failures5xx, 1);
  assert.deepEqual(crossRoute5xx.stopReasons, ['HTTP_5XX']);
  const noHealth = logs.analyzeHttp(Array.from({ length: 20 }, () => ({
    httpStatus: 200, totalDuration: 20, path: '/api/finance/budget-drafts/capabilities'
  })), 0);
  assert.deepEqual(noHealth.stopReasons, ['INSUFFICIENT_HEALTH_SAMPLES']);
});

test('application log analyzer accepts only the sanitized Budget event contract', () => {
  const revision = '5abd8df142065a11a631490c440328c752fe8cdd';
  const safe = { event: 'budget_request', timestamp: '2026-09-06T00:00:00.000Z',
    correlationId: 'test', outcome: 'completed', method: 'GET',
    route: '/api/finance/budget-drafts', status: 200, durationMs: 12,
    code: null, revision };
  assert.equal(logs.analyzeApplication([{ message: JSON.stringify(safe) }], revision).status, 'passed');
  const unsafe = logs.analyzeApplication([{ ...safe, amount: 42 }], revision);
  assert.equal(unsafe.status, 'stop');
  assert.deepEqual(unsafe.unsafeFields, ['amount']);
  const missing = { ...safe };
  delete missing.durationMs;
  assert.deepEqual(logs.analyzeApplication([missing], revision).stopReasons,
    ['MISSING_EVENT_FIELDS', 'INVALID_EVENT_CONTRACT']);
  assert.deepEqual(logs.analyzeApplication([{ ...safe, revision: '0'.repeat(40) }], revision).stopReasons,
    ['UNAUTHORIZED_EVENT_REVISION', 'INVALID_EVENT_CONTRACT']);
  assert.deepEqual(logs.parseArgs(['--application', '--expected-revision', revision]), {
    mode: 'application', expectedRevision: revision
  });
});

test('alert self-test emits a safe stop marker and exits with alert code', async () => {
  const output = [];
  const code = await logs.main(['--self-test-alert'], {
    input: Readable.from([]), log: value => output.push(value)
  });
  assert.equal(code, 2);
  assert.deepEqual(output[0].stopReasons, ['HTTP_5XX', 'HEALTH_UNAVAILABLE']);
  assert.equal(output[0].alert, 'BUDGET_PREVIEW_STOP');
});

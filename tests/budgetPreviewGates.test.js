const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const transitions = require('../scripts/testBudgetPreviewTransitions');
const logs = require('../scripts/analyzeBudgetPreviewLogs');
const health = require('../scripts/sampleBudgetPreviewHealth');

const primary = 'https://preview-a.example.test/api';
const secondary = 'https://preview-b.example.test/api';
const httpRecord = (value, index = 0) => ({
  timestamp: new Date(index * 15000).toISOString(), ...value
});

test('preview transition plan is offline and execution requires two exact non-production targets', async () => {
  const revision = '5abd8df142065a11a631490c440328c752fe8cdd';
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
    '--confirm', `${primary}|${secondary}`, '--expected-revision', revision], env), {
    execute: true, primaryUrl: primary, secondaryUrl: secondary,
    confirmation: `${primary}|${secondary}`, expectedRevision: revision
  });
  await assert.rejects(() => transitions.runPreviewTransitions({
    execute: true, primaryUrl: 'https://seneswiss-group.com/api',
    secondaryUrl: secondary, confirmation: `https://seneswiss-group.com/api|${secondary}`,
    expectedRevision: revision
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
  const revision = '5abd8df142065a11a631490c440328c752fe8cdd';
  const token = kid => {
    const value = kid ? { alg: 'HS256', typ: 'JWT', kid } : { alg: 'HS256', typ: 'JWT' };
    return `${Buffer.from(JSON.stringify(value)).toString('base64url')}.payload.signature`;
  };
  const legacy = token();
  const old = token('preview-old');
  const current = token('preview-new');
  let phase = 'LEGACY_BASELINE';
  let clock = 0;
  const prompts = [];
  const observations = [];
  const loginOrigins = [];
  const response = (status, payload = {}) => ({ status, async json() { return payload; } });
  const fetchImpl = async (url, options = {}) => {
    clock += 10;
    const path = new URL(url).pathname;
    const authorization = options.headers?.Authorization || '';
    const bearer = authorization.replace(/^Bearer /, '');
    if (path.endsWith('/health')) return response(200, { status: 'ok', revision });
    if (path.endsWith('/auth/login')) {
      loginOrigins.push({ phase, origin: new URL(url).origin });
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
    confirmation: `${primary}|${secondary}`, expectedRevision: revision };
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
    sleep: async delay => { clock += delay; },
    now: () => clock,
    samples: transitions.OBSERVATION_SAMPLES,
    intervalMs: transitions.OBSERVATION_INTERVAL_MS,
    log: value => observations.push(value)
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(prompts, transitions.PHASES);
  assert.deepEqual(report.phases, ['LEGACY_BASELINE', ...transitions.PHASES]);
  assert.deepEqual(observations.map(item => item.phase), report.phases);
  observations.forEach(item => {
    assert.equal(Date.parse(item.endUtc) - Date.parse(item.startUtc), 300000);
  });
  assert.deepEqual(loginOrigins.filter(item => item.phase === 'SECONDARY_SHARED'), [
    { phase: 'SECONDARY_SHARED', origin: new URL(secondary).origin }
  ]);
  assert.equal(JSON.stringify(report).includes('signature'), false);
});

test('preview transition runner rejects a healthy response from another revision', async () => {
  const revision = '5abd8df142065a11a631490c440328c752fe8cdd';
  const report = await transitions.runPreviewTransitions({
    execute: true, primaryUrl: primary, secondaryUrl: secondary,
    confirmation: `${primary}|${secondary}`, expectedRevision: revision
  }, {
    env: { BUDGET_HTTP_OWNER_EMAIL: 'owner@example.test',
      BUDGET_HTTP_OWNER_PASSWORD: 'synthetic-only' },
    fetchImpl: async () => ({ status: 200,
      async json() { return { status: 'ok', revision: '0'.repeat(40) }; } }),
    prompt: async () => '', sleep: async () => {},
    samples: transitions.OBSERVATION_SAMPLES,
    intervalMs: transitions.OBSERVATION_INTERVAL_MS
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'HEALTH_REVISION_MISMATCH');
});

test('HTTP log analyzer enforces 5xx, 409 and latency thresholds', () => {
  const passed = logs.analyzeHttp([
    ...Array.from({ length: 20 }, (_, index) => ({
      httpStatus: 200, totalDuration: 100 + index, path: '/api/health'
    })).map(httpRecord),
    httpRecord({ httpStatus: 409, totalDuration: 120,
      path: '/api/finance/budget-drafts/:id' }, 19)
  ], 1);
  assert.equal(passed.status, 'passed');
  const stopped = logs.analyzeHttp(Array.from({ length: 20 }, (_, index) => httpRecord({
    httpStatus: 500, totalDuration: 3100, path: '/api/health'
  }, index)), 0);
  assert.equal(stopped.status, 'stop');
  assert.deepEqual(stopped.stopReasons, [
    'HTTP_5XX', 'HEALTH_UNAVAILABLE', 'HTTP_P95_THRESHOLD', 'HTTP_MAX_THRESHOLD'
  ]);
  const unavailable = logs.analyzeHttp(Array.from({ length: 20 }, (_, index) => httpRecord({
    httpStatus: 404, totalDuration: 20, path: '/api/health'
  }, index)), 0);
  assert.deepEqual(unavailable.stopReasons, ['HEALTH_UNAVAILABLE']);
  const crossRoute5xx = logs.analyzeHttp([
    ...Array.from({ length: 20 }, (_, index) => httpRecord({
      httpStatus: 200, totalDuration: 20, path: '/api/health'
    }, index)),
    httpRecord({ httpStatus: 503, totalDuration: 5, path: '/api/auth/login' }, 19)
  ], 0);
  assert.equal(crossRoute5xx.failures5xx, 1);
  assert.deepEqual(crossRoute5xx.stopReasons, ['HTTP_5XX']);
  const crossRoute409 = logs.analyzeHttp([
    ...Array.from({ length: 20 }, (_, index) => httpRecord({
      httpStatus: 200, totalDuration: 20, path: '/api/health'
    }, index)),
    httpRecord({ httpStatus: 409, totalDuration: 5, path: '/api/auth/login' }, 19)
  ], 0);
  assert.equal(crossRoute409.conflicts409, 1);
  assert.deepEqual(crossRoute409.stopReasons, ['HTTP_409_THRESHOLD']);
  const noHealth = logs.analyzeHttp(Array.from({ length: 20 }, (_, index) => httpRecord({
    httpStatus: 200, totalDuration: 20, path: '/api/finance/budget-drafts/capabilities'
  }, index)), 0);
  assert.deepEqual(noHealth.stopReasons, ['INSUFFICIENT_HEALTH_SAMPLES']);
  const incomplete = logs.analyzeHttp([
    ...Array.from({ length: 20 }, (_, index) => httpRecord({
      httpStatus: 200, totalDuration: 20, path: '/api/health'
    }, index)),
    { timestamp: new Date(300000).toISOString(), path: '/api/health', totalDuration: 20 }
  ], 0);
  assert.deepEqual(incomplete.stopReasons, ['INVALID_HTTP_LOG_RECORDS']);
  const coerced = logs.analyzeHttp([
    ...Array.from({ length: 20 }, (_, index) => httpRecord({
      httpStatus: 200, totalDuration: 20, path: '/api/health'
    }, index)),
    { timestamp: new Date(300000).toISOString(), path: '/api/auth/login',
      httpStatus: null, totalDuration: '' }
  ], 0);
  assert.deepEqual(coerced.stopReasons, ['INVALID_HTTP_LOG_RECORDS']);
  const gap = Array.from({ length: 20 }, (_, index) => httpRecord({
    httpStatus: 200, totalDuration: 20, path: '/api/health'
  }, index < 10 ? index : index + 3));
  assert.deepEqual(logs.analyzeHttp(gap, 0, 0, logs.parseExpectedWindow(
    '1970-01-01T00:00:00.000Z', '1970-01-01T00:05:45.000Z'
  )).stopReasons, ['INCOMPLETE_HTTP_TIME_COVERAGE']);
  assert.deepEqual(logs.parseArgs(['--http', '--expected-409', '0',
    '--start-utc', '1970-01-01T00:00:00.000Z',
    '--end-utc', '1970-01-01T00:05:00.000Z']), {
    mode: 'http', expected409: 0,
    expectedWindow: { startUtc: '1970-01-01T00:00:00.000Z',
      endUtc: '1970-01-01T00:05:00.000Z', startMs: 0, endMs: 300000 }
  });
  assert.throws(() => logs.parseArgs(['--http', '--expected-409', '0']),
    /HTTP_EXPECTATIONS_REQUIRED/);
});

test('application log analyzer accepts only the sanitized Budget event contract', () => {
  const revision = '5abd8df142065a11a631490c440328c752fe8cdd';
  const safe = { event: 'budget_request', timestamp: '2026-09-06T00:00:00.000Z',
    correlationId: '123e4567-e89b-42d3-a456-426614174000',
    outcome: 'completed', method: 'GET',
    route: '/api/finance/budget-drafts', status: 200, durationMs: 12,
    code: null, revision };
  assert.equal(logs.analyzeApplication(
    [{ message: JSON.stringify(safe) }], revision, { 200: 1 }
  ).status, 'passed');
  const truncatedNested = logs.analyzeApplication([
    { message: JSON.stringify(safe) },
    { message: '{"event":"budget_request","status":200' }
  ], revision, { 200: 1 });
  assert.equal(truncatedNested.malformedRecords, 1);
  assert.equal(truncatedNested.unreadableApplicationRecords, 1);
  assert.deepEqual(truncatedNested.stopReasons, ['MALFORMED_LOG_RECORDS']);
  const unsafe = logs.analyzeApplication([{ ...safe, amount: 42 }], revision, { 200: 1 });
  assert.equal(unsafe.status, 'stop');
  assert.deepEqual(unsafe.unsafeFields, ['amount']);
  const missing = { ...safe };
  delete missing.durationMs;
  assert.deepEqual(logs.analyzeApplication([missing], revision, { 200: 1 }).stopReasons,
    ['MISSING_EVENT_FIELDS', 'INVALID_EVENT_CONTRACT']);
  assert.deepEqual(logs.analyzeApplication(
    [{ ...safe, revision: '0'.repeat(40) }], revision, { 200: 1 }
  ).stopReasons,
    ['UNAUTHORIZED_EVENT_REVISION', 'INVALID_EVENT_CONTRACT']);
  assert.deepEqual(logs.analyzeApplication(
    [{ ...safe, method: 'BANANA' }], revision, { 200: 1 }
  ).stopReasons, ['INVALID_EVENT_CONTRACT']);
  assert.deepEqual(logs.analyzeApplication(
    [{ ...safe, method: 'POST', route: '/api/finance/budget-drafts/capabilities' }],
    revision, { 200: 1 }
  ).stopReasons, ['INVALID_EVENT_CONTRACT']);
  assert.deepEqual(logs.analyzeApplication(
    [{ ...safe, method: 'PUT', route: '/api/finance/budget-drafts' }],
    revision, { 200: 1 }
  ).stopReasons, ['INVALID_EVENT_CONTRACT']);
  assert.equal(logs.validApplicationMethodRoute('PUT', '/api/finance/budget-drafts/:id'), true);
  assert.deepEqual(logs.analyzeApplication(
    [{ ...safe, outcome: 'aborted' }], revision, { 200: 1 }
  ).stopReasons, ['INVALID_EVENT_CONTRACT']);
  const aborted = { ...safe, correlationId: '123e4567-e89b-42d3-a456-426614174001',
    outcome: 'aborted', status: 499, code: 'CLIENT_CLOSED_REQUEST' };
  assert.equal(logs.analyzeApplication([aborted], revision, { 499: 1 }).status, 'passed');
  assert.deepEqual(logs.analyzeApplication([
    safe, { ...safe, timestamp: '2026-09-06T00:00:01.000Z' }
  ], revision, { 200: 2 }).stopReasons, ['DUPLICATE_CORRELATION_IDS']);
  assert.deepEqual(logs.analyzeApplication([safe], revision, { 200: 1, 401: 1 }).stopReasons,
    ['EVENT_STATUS_MISMATCH']);
  assert.deepEqual(logs.parseArgs(['--application', '--expected-revision', revision,
    '--expected-statuses', '200:3,201:1,401:1,404:2,409:1']), {
    mode: 'application', expectedRevision: revision,
    expectedStatuses: { 200: 3, 201: 1, 401: 1, 404: 2, 409: 1 }
  });
  assert.throws(() => logs.parseExpectedStatuses('200:1,200:2'),
    /EXPECTED_STATUSES_INVALID/);
});

test('final preview health sampler is inert by default and target-bound for execution', async () => {
  const revision = '5abd8df142065a11a631490c440328c752fe8cdd';
  let fetched = false;
  const output = [];
  assert.equal(await health.main([], {
    fetchImpl() { fetched = true; }, log: value => output.push(value)
  }), 0);
  assert.equal(fetched, false);
  assert.equal(output[0].networkAccess, false);
  assert.throws(() => health.parseArgs(['--execute', '--non-production', '--url', primary,
    '--confirm', 'https://wrong.example.test/api', '--phase', 'FINAL_CLEANUP',
    '--expected-revision', revision]),
  /EXACT_TARGET_CONFIRMATION_REQUIRED/);
  assert.throws(() => health.parseArgs(['--execute', '--non-production', '--url',
    'https://seneswiss-group.com/api', '--confirm', 'https://seneswiss-group.com/api',
    '--phase', 'FINAL_CLEANUP', '--expected-revision', revision]), /PRODUCTION_TARGET_FORBIDDEN/);
  assert.throws(() => health.parseArgs(['--execute', '--non-production', '--url', primary,
    '--confirm', primary, '--phase', 'FINAL_CLEANUP']), /EXPECTED_REVISION_REQUIRED/);
});

test('final preview health sampler requires twenty successful bounded observations', async () => {
  const revision = '5abd8df142065a11a631490c440328c752fe8cdd';
  let calls = 0;
  let clock = 0;
  const sleepDelays = [];
  const config = { baseUrl: primary, confirmation: primary, phase: 'ROLLBACK_1_CLOSED',
    expectedRevision: revision };
  const report = await health.sampleHealth(config, {
    fetchImpl: async url => {
      assert.equal(url, `${primary}/health`);
      calls += 1;
      clock += 1000;
      return { status: 200, async json() { return { revision }; } };
    },
    sleep: async delay => { sleepDelays.push(delay); clock += delay; },
    now: () => clock, samples: health.SAMPLES, intervalMs: health.INTERVAL_MS
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.samples, 20);
  assert.equal(calls, 20);
  assert.deepEqual(sleepDelays, Array(20).fill(14000));
  assert.equal(report.startUtc, '1970-01-01T00:00:00.000Z');
  assert.equal(report.endUtc, '1970-01-01T00:05:00.000Z');
  await assert.rejects(() => health.sampleHealth(config, {
    fetchImpl: async () => ({ status: 503 }), sleep: async () => {},
    samples: health.SAMPLES, intervalMs: health.INTERVAL_MS
  }), /HEALTH_UNAVAILABLE/);
  await assert.rejects(() => health.sampleHealth(config, {
    fetchImpl: async () => ({ status: 200, async json() { return { revision: '0'.repeat(40) }; } }),
    sleep: async () => {}, samples: health.SAMPLES, intervalMs: health.INTERVAL_MS
  }), /HEALTH_REVISION_MISMATCH/);
  let slowClock = 0;
  await assert.rejects(() => health.sampleHealth(config, {
    fetchImpl: async () => ({ status: 200,
      async json() { slowClock += 2000; return { revision }; } }),
    sleep: async delay => { slowClock += delay; }, now: () => slowClock,
    samples: health.SAMPLES, intervalMs: health.INTERVAL_MS
  }), /HEALTH_LATENCY_THRESHOLD/);
});

test('deployment health guard accepts only the original and pinned revisions', async () => {
  const original = '52876c59a82b2073bcda28fc6211725bbc28c46b';
  const pinned = '5abd8df142065a11a631490c440328c752fe8cdd';
  const config = { baseUrl: primary, confirmation: primary, phase: 'DEPLOYMENT_GUARD',
    allowedRevisions: [original, pinned] };
  let clock = 0;
  let calls = 0;
  const report = await health.sampleHealth(config, {
    fetchImpl: async () => ({ status: 200,
      async json() { calls += 1; return { revision: calls < 10 ? original : pinned }; } }),
    sleep: async delay => { clock += delay; }, now: () => clock,
    samples: health.SAMPLES, intervalMs: health.INTERVAL_MS
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.allowedRevisions, [original, pinned]);
  assert.throws(() => health.parseArgs(['--execute', '--non-production', '--url', primary,
    '--confirm', primary, '--phase', 'DEPLOYMENT_GUARD', '--allowed-revisions', original]),
  /TWO_ALLOWED_REVISIONS_REQUIRED/);
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

test('log analyzer stops when a nonempty Railway record is malformed', async () => {
  const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify(httpRecord({
    httpStatus: 200, totalDuration: 20, path: '/api/health'
  }, index)));
  lines.splice(10, 0, '{truncated');
  const output = [];
  const code = await logs.main(['--http', '--expected-409', '0',
    '--start-utc', '1970-01-01T00:00:00.000Z',
    '--end-utc', '1970-01-01T00:05:00.000Z'], {
    input: Readable.from(`${lines.join('\n')}\n`), log: value => output.push(value)
  });
  assert.equal(code, 2);
  assert.equal(output[0].malformedRecords, 1);
  assert.deepEqual(output[0].stopReasons, ['MALFORMED_LOG_RECORDS']);
});

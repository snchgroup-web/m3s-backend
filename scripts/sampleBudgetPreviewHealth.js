const { normalizeUrl } = require('./testBudgetHttp');

const PHASES = new Set([
  'RUN_GUARD', 'HTTP_ACCEPTANCE', 'ROLLBACK_1_CLOSED',
  'ROLLBACK_2_CLOSED', 'FINAL_CLEANUP'
]);
const SAMPLES = 20;
const INTERVAL_MS = 15000;
const refusal = code => { const error = new Error(code); error.safeCode = code; throw error; };

function parseArgs(args) {
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--plan', '--execute', '--non-production', '--url', '--confirm', '--phase',
      '--expected-revision'].includes(key)
      || Object.hasOwn(flags, key)) refusal('INVALID_ARGUMENTS');
    if (['--plan', '--execute', '--non-production'].includes(key)) flags[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) refusal('MISSING_ARGUMENT_VALUE');
      flags[key] = value;
    }
  }
  if (flags['--plan'] && flags['--execute']) refusal('CONFLICTING_MODES');
  const execute = flags['--execute'] === true;
  const baseUrl = flags['--url'] ? normalizeUrl(flags['--url']) : null;
  if (execute && (!baseUrl || flags['--non-production'] !== true)) {
    refusal('NON_PRODUCTION_TARGET_REQUIRED');
  }
  if (execute && flags['--confirm'] !== baseUrl) refusal('EXACT_TARGET_CONFIRMATION_REQUIRED');
  if (execute && !PHASES.has(flags['--phase'])) refusal('BOUNDED_PHASE_REQUIRED');
  if (execute && !/^[0-9a-f]{40}$/i.test(flags['--expected-revision'] || '')) {
    refusal('EXPECTED_REVISION_REQUIRED');
  }
  if (!execute && (flags['--non-production'] || flags['--confirm'] || flags['--phase']
    || flags['--expected-revision'])) {
    refusal('EXECUTION_FLAGS_REQUIRE_EXECUTE');
  }
  return { execute, baseUrl, confirmation: flags['--confirm'], phase: flags['--phase'],
    expectedRevision: flags['--expected-revision']?.toLowerCase() };
}

async function sampleHealth(config, {
  fetchImpl = global.fetch,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  now = Date.now,
  samples = SAMPLES,
  intervalMs = INTERVAL_MS
} = {}) {
  config = parseArgs(['--execute', '--non-production', '--url', config.baseUrl,
    '--confirm', config.confirmation, '--phase', config.phase,
    '--expected-revision', config.expectedRevision]);
  if (typeof fetchImpl !== 'function') refusal('FETCH_UNAVAILABLE');
  if (samples !== SAMPLES || intervalMs !== INTERVAL_MS) refusal('OBSERVATION_WINDOW_FIXED');
  const durations = [];
  const phaseStartedAt = now();
  for (let index = 0; index < samples; index++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const started = now();
    try {
      const response = await fetchImpl(`${config.baseUrl}/health`, { signal: controller.signal });
      durations.push(now() - started);
      if (response.status !== 200) refusal('HEALTH_UNAVAILABLE');
      let payload;
      try { payload = await response.json(); } catch { refusal('HEALTH_REVISION_UNAVAILABLE'); }
      if (payload?.revision !== config.expectedRevision) refusal('HEALTH_REVISION_MISMATCH');
    } finally { clearTimeout(timer); }
    const nextSampleAt = phaseStartedAt + ((index + 1) * intervalMs);
    await sleep(Math.max(0, nextSampleAt - now()));
  }
  const ordered = [...durations].sort((left, right) => left - right);
  const p95Ms = ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0;
  const maxMs = Math.max(...durations);
  if (p95Ms > 1500 || maxMs > 3000) refusal('HEALTH_LATENCY_THRESHOLD');
  return { mode: 'preview-health', phase: config.phase, target: config.baseUrl,
    expectedRevision: config.expectedRevision,
    startUtc: new Date(phaseStartedAt).toISOString(), endUtc: new Date(now()).toISOString(),
    status: 'passed', samples: durations.length, intervalMs, p95Ms, maxMs };
}

async function main(args = process.argv.slice(2), {
  fetchImpl = global.fetch, log = value => console.log(JSON.stringify(value))
} = {}) {
  try {
    const config = parseArgs(args);
    if (!config.execute) {
      log({ mode: 'plan', networkAccess: false, executionAuthorized: false,
        phases: [...PHASES], samples: SAMPLES, intervalMs: INTERVAL_MS,
        windowMs: SAMPLES * INTERVAL_MS });
      return 0;
    }
    const report = await sampleHealth(config, { fetchImpl });
    log(report);
    return 0;
  } catch (error) {
    log({ status: 'failed', alert: 'BUDGET_PREVIEW_STOP',
      reason: error.safeCode || 'CHECK_FAILED' });
    return 2;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { parseArgs, sampleHealth, main, PHASES, SAMPLES, INTERVAL_MS };

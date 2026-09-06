const assert = require('node:assert/strict');
const readline = require('node:readline/promises');
const { normalizeUrl, syntheticBudget } = require('./testBudgetHttp');

const REQUIRED_ENV = ['BUDGET_HTTP_OWNER_EMAIL', 'BUDGET_HTTP_OWNER_PASSWORD'];
const PHASES = [
  'PRIMARY_SHARED',
  'SECONDARY_SHARED',
  'NEW_ACTIVE_BOTH',
  'OLD_REMOVED_BOTH',
  'WRITE_REMOVED_BOTH',
  'OWNER_DISABLED_BOTH'
];
const OBSERVATION_SAMPLES = 20;
const OBSERVATION_INTERVAL_MS = 15000;

const refusal = code => { const error = new Error(code); error.safeCode = code; throw error; };

function parseArgs(args, env = {}) {
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--plan', '--execute', '--non-production', '--primary-url', '--secondary-url', '--confirm']
      .includes(key) || Object.hasOwn(flags, key)) refusal('INVALID_ARGUMENTS');
    if (['--plan', '--execute', '--non-production'].includes(key)) flags[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) refusal('MISSING_ARGUMENT_VALUE');
      flags[key] = value;
    }
  }
  if (flags['--plan'] && flags['--execute']) refusal('CONFLICTING_MODES');
  const execute = flags['--execute'] === true;
  const primaryUrl = flags['--primary-url'] ? normalizeUrl(flags['--primary-url']) : null;
  const secondaryUrl = flags['--secondary-url'] ? normalizeUrl(flags['--secondary-url']) : null;
  if (execute && (!primaryUrl || !secondaryUrl || primaryUrl === secondaryUrl)) {
    refusal('TWO_DISTINCT_PREVIEW_URLS_REQUIRED');
  }
  if (execute && flags['--non-production'] !== true) refusal('NON_PRODUCTION_ATTESTATION_REQUIRED');
  if (execute && flags['--confirm'] !== `${primaryUrl}|${secondaryUrl}`) {
    refusal('EXACT_TARGET_CONFIRMATION_REQUIRED');
  }
  if (!execute && (flags['--non-production'] || flags['--confirm'])) {
    refusal('EXECUTION_FLAGS_REQUIRE_EXECUTE');
  }
  if (execute && REQUIRED_ENV.some(key => typeof env[key] !== 'string' || !env[key])) {
    refusal('TEST_OWNER_CREDENTIALS_REQUIRED');
  }
  return { execute, primaryUrl, secondaryUrl, confirmation: flags['--confirm'] };
}

function tokenHeader(token) {
  try {
    const encoded = String(token || '').split('.')[0];
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch { return null; }
}

function percentile95(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0;
}

async function runPreviewTransitions(config, {
  env = process.env,
  fetchImpl = global.fetch,
  prompt = null,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  samples = OBSERVATION_SAMPLES,
  intervalMs = OBSERVATION_INTERVAL_MS,
  log = () => {}
} = {}) {
  if (!config.execute) refusal('EXECUTION_REQUIRED');
  config = parseArgs(['--execute', '--non-production', '--primary-url', config.primaryUrl,
    '--secondary-url', config.secondaryUrl, '--confirm', config.confirmation], env);
  if (typeof fetchImpl !== 'function' || typeof prompt !== 'function') refusal('RUNTIME_UNAVAILABLE');
  if (samples !== OBSERVATION_SAMPLES || intervalMs !== OBSERVATION_INTERVAL_MS) {
    refusal('OBSERVATION_WINDOW_FIXED');
  }

  const metrics = [];
  const call = async (baseUrl, path, { method = 'GET', token, body } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const started = Date.now();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const durationMs = Date.now() - started;
      let payload = null;
      try { payload = await response.json(); } catch { /* Status is still measured. */ }
      metrics.push({ status: response.status, durationMs, path });
      return { status: response.status, payload };
    } finally { clearTimeout(timer); }
  };
  const login = async baseUrl => {
    const response = await call(baseUrl, '/auth/login', { method: 'POST', body: {
      email: env.BUDGET_HTTP_OWNER_EMAIL,
      password: env.BUDGET_HTTP_OWNER_PASSWORD
    } });
    assert.equal(response.status, 200);
    assert.equal(typeof response.payload?.token, 'string');
    return response.payload.token;
  };
  const capabilities = async (baseUrl, token, status = 200, canWrite = undefined) => {
    const response = await call(baseUrl, '/finance/budget-drafts/capabilities', { token });
    assert.equal(response.status, status);
    if (canWrite !== undefined) assert.equal(response.payload?.canWrite, canWrite);
  };
  const bothCapabilities = async (token, status = 200, canWrite = undefined) => {
    await Promise.all([
      capabilities(config.primaryUrl, token, status, canWrite),
      capabilities(config.secondaryUrl, token, status, canWrite)
    ]);
  };
  const gate = async phase => {
    const answer = await prompt(`Type CONFIRM ${phase} after the bounded Railway changes: `);
    if (answer !== `CONFIRM ${phase}`) refusal(`OPERATOR_GATE_${phase}_REFUSED`);
  };
  const observe = async phase => {
    const durations = [];
    for (let index = 0; index < samples; index++) {
      const started = Date.now();
      const responses = await Promise.all([
        call(config.primaryUrl, '/health'), call(config.secondaryUrl, '/health')
      ]);
      responses.forEach(response => assert.equal(response.status, 200));
      durations.push(Date.now() - started);
      if (index + 1 < samples) await sleep(intervalMs);
    }
    const p95Ms = percentile95(durations);
    const maxMs = Math.max(...durations);
    if (p95Ms > 1500 || maxMs > 3000) refusal('OBSERVATION_LATENCY_THRESHOLD');
    log({ phase, healthSamples: samples * 2, p95Ms, maxMs, status: 'passed' });
  };

  const report = { mode: 'preview-p3-p4', status: 'running', phases: [],
    targets: [config.primaryUrl, config.secondaryUrl], secretsLogged: false };
  try {
    await Promise.all([call(config.primaryUrl, '/health'), call(config.secondaryUrl, '/health')])
      .then(responses => responses.forEach(response => assert.equal(response.status, 200)));
    const legacyToken = await login(config.primaryUrl);
    let oldProviderToken;
    assert.equal(tokenHeader(legacyToken)?.kid, undefined);
    await bothCapabilities(legacyToken);
    await observe('LEGACY_BASELINE');
    report.phases.push('LEGACY_BASELINE');

    await gate(PHASES[0]);
    await bothCapabilities(legacyToken);
    oldProviderToken = await login(config.primaryUrl);
    assert.equal(tokenHeader(oldProviderToken)?.kid, 'preview-old');
    await bothCapabilities(oldProviderToken);
    await observe(PHASES[0]);
    report.phases.push(PHASES[0]);

    await gate(PHASES[1]);
    await bothCapabilities(legacyToken);
    await bothCapabilities(oldProviderToken);
    await observe('SHARED_BOTH');
    report.phases.push(PHASES[1]);

    await gate(PHASES[2]);
    const newProviderToken = await login(config.primaryUrl);
    assert.equal(tokenHeader(newProviderToken)?.kid, 'preview-new');
    await bothCapabilities(oldProviderToken);
    await bothCapabilities(newProviderToken);
    await observe(PHASES[2]);
    report.phases.push(PHASES[2]);

    await gate(PHASES[3]);
    await bothCapabilities(legacyToken, 401);
    await bothCapabilities(oldProviderToken, 401);
    await bothCapabilities(newProviderToken);
    await observe(PHASES[3]);
    report.phases.push(PHASES[3]);

    await gate(PHASES[4]);
    await bothCapabilities(newProviderToken, 200, false);
    const deniedBudget = syntheticBudget('permission-revocation');
    const denied = await Promise.all([config.primaryUrl, config.secondaryUrl].map(baseUrl => call(
      baseUrl, '/finance/budget-drafts', { method: 'POST', token: newProviderToken,
        body: { budget: deniedBudget } }
    )));
    denied.forEach(response => assert.equal(response.status, 403));
    await observe(PHASES[4]);
    report.phases.push(PHASES[4]);

    await gate(PHASES[5]);
    await bothCapabilities(newProviderToken, 401);
    await observe(PHASES[5]);
    report.phases.push(PHASES[5]);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.reason = error.safeCode || 'CHECK_FAILED';
    report.alert = 'BUDGET_PREVIEW_STOP';
  }
  report.measurements = metrics.length;
  return report;
}

async function main(args = process.argv.slice(2), {
  env = process.env, fetchImpl = global.fetch, log = value => console.log(JSON.stringify(value))
} = {}) {
  let rl;
  try {
    const config = parseArgs(args, env);
    if (!config.execute) {
      log({ mode: 'plan', networkAccess: false, executionAuthorized: false, phases: PHASES,
        observation: { samplesPerService: OBSERVATION_SAMPLES, intervalMs: OBSERVATION_INTERVAL_MS },
        requires: ['Two distinct non-production preview URLs.', 'One pre-provisioned fictional owner.',
          'Exact target confirmation.', 'Operator confirmation after every Railway mutation.'] });
      return 0;
    }
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const report = await runPreviewTransitions(config, { env, fetchImpl,
      prompt: question => rl.question(question), log });
    log(report);
    return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    log({ status: 'refused', reason: error.safeCode || 'SETUP_FAILED' });
    return 1;
  } finally { rl?.close(); }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { parseArgs, tokenHeader, percentile95, runPreviewTransitions, main,
  PHASES, OBSERVATION_SAMPLES, OBSERVATION_INTERVAL_MS };

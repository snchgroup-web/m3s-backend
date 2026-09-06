const readline = require('node:readline');

const SAFE_EVENT_FIELDS = new Set([
  'event', 'timestamp', 'correlationId', 'outcome', 'method', 'route',
  'status', 'durationMs', 'code', 'revision'
]);

const percentile95 = values => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0;
};

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function applicationEvent(line) {
  if (line?.event === 'budget_request') return line;
  if (typeof line?.message === 'string') {
    const nested = parseJson(line.message);
    if (nested?.event === 'budget_request') return nested;
  }
  return null;
}

function analyzeHttp(lines, expected409 = 0) {
  const allRows = lines.filter(row => Number.isInteger(Number(row.httpStatus)));
  const healthRows = allRows.filter(row => ['/api/health', '/health']
    .includes(String(row.path || '')));
  const rows = allRows.filter(row => (
    String(row.path || '').startsWith('/api/finance/budget-drafts')
      || ['/api/health', '/health'].includes(String(row.path || ''))));
  const durations = rows.map(row => Number(row.totalDuration)).filter(Number.isFinite);
  const statuses = rows.map(row => Number(row.httpStatus));
  const failures5xx = allRows.filter(row => Number(row.httpStatus) >= 500).length;
  const healthFailures = healthRows.filter(row => Number(row.httpStatus) !== 200).length;
  const conflicts409 = statuses.filter(status => status === 409).length;
  const p95Ms = percentile95(durations);
  const maxMs = durations.length ? Math.max(...durations) : 0;
  const stopReasons = [];
  if (!rows.length || durations.length !== rows.length) stopReasons.push('INCOMPLETE_HTTP_LOGS');
  if (rows.length < 20) stopReasons.push('INSUFFICIENT_HTTP_SAMPLES');
  if (healthRows.length < 20) stopReasons.push('INSUFFICIENT_HEALTH_SAMPLES');
  if (failures5xx) stopReasons.push('HTTP_5XX');
  if (healthFailures) stopReasons.push('HEALTH_UNAVAILABLE');
  if (conflicts409 !== expected409 || (rows.length && conflicts409 / rows.length > 0.05)) {
    stopReasons.push('HTTP_409_THRESHOLD');
  }
  if (p95Ms > 1500) stopReasons.push('HTTP_P95_THRESHOLD');
  if (maxMs > 3000) stopReasons.push('HTTP_MAX_THRESHOLD');
  return { kind: 'http', status: stopReasons.length ? 'stop' : 'passed',
    totalHttpRows: allRows.length, samples: rows.length, healthSamples: healthRows.length,
    failures5xx, healthFailures,
    conflicts409, expected409, p95Ms, maxMs,
    alert: stopReasons.length ? 'BUDGET_PREVIEW_STOP' : null, stopReasons };
}

function validApplicationEvent(event, expectedRevision) {
  const fields = Object.keys(event).sort();
  const expectedFields = [...SAFE_EVENT_FIELDS].sort();
  return fields.length === expectedFields.length
    && fields.every((field, index) => field === expectedFields[index])
    && event.event === 'budget_request'
    && typeof event.timestamp === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.timestamp)
    && Number.isFinite(Date.parse(event.timestamp))
    && typeof event.correlationId === 'string'
    && event.correlationId.length > 0
    && event.correlationId.length <= 128
    && ['completed', 'aborted'].includes(event.outcome)
    && typeof event.method === 'string'
    && /^[A-Z]{3,10}$/.test(event.method)
    && /^\/api\/finance\/budget-drafts(?:\/capabilities|\/:id|\/:invalid)?$/.test(event.route)
    && Number.isInteger(event.status)
    && event.status >= 100
    && event.status <= 599
    && Number.isInteger(event.durationMs)
    && event.durationMs >= 0
    && (event.code === null || (typeof event.code === 'string'
      && /^[A-Z][A-Z0-9_]{0,63}$/.test(event.code)))
    && event.revision === expectedRevision;
}

function analyzeApplication(lines, expectedRevision) {
  const events = lines.map(applicationEvent).filter(Boolean);
  const unsafeFields = [...new Set(events.flatMap(event => Object.keys(event)
    .filter(key => !SAFE_EVENT_FIELDS.has(key))))].sort();
  const missingFields = [...new Set(events.flatMap(event => [...SAFE_EVENT_FIELDS]
    .filter(key => !Object.hasOwn(event, key))))].sort();
  const invalidEvents = events.filter(event => !validApplicationEvent(event, expectedRevision)).length;
  const invalidRevisions = events.filter(event => event.revision !== expectedRevision).length;
  const stopReasons = [];
  if (!events.length) stopReasons.push('NO_BUDGET_EVENTS');
  if (unsafeFields.length) stopReasons.push('UNSAFE_EVENT_FIELDS');
  if (missingFields.length) stopReasons.push('MISSING_EVENT_FIELDS');
  if (invalidRevisions) stopReasons.push('UNAUTHORIZED_EVENT_REVISION');
  if (invalidEvents) stopReasons.push('INVALID_EVENT_CONTRACT');
  return { kind: 'application', status: stopReasons.length ? 'stop' : 'passed',
    events: events.length, expectedRevision, unsafeFields, missingFields,
    invalidEvents, invalidRevisions,
    alert: stopReasons.length ? 'BUDGET_PREVIEW_STOP' : null, stopReasons };
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test-alert') return { selfTest: true };
  if (!['--http', '--application'].includes(args[0])) throw new Error('MODE_REQUIRED');
  if (args[0] === '--application') {
    if (args.length !== 3 || args[1] !== '--expected-revision'
      || !/^[0-9a-f]{40}$/i.test(args[2])) throw new Error('EXPECTED_REVISION_REQUIRED');
    return { mode: 'application', expectedRevision: args[2].toLowerCase() };
  }
  if (args[0] === '--http') {
    if (args.length !== 3 || args[1] !== '--expected-409' || !/^\d+$/.test(args[2])) {
      throw new Error('EXPECTED_409_REQUIRED');
    }
    return { mode: 'http', expected409: Number(args[2]) };
  }
  throw new Error('INVALID_ARGUMENTS');
}

async function main(args = process.argv.slice(2), {
  input = process.stdin, log = value => console.log(JSON.stringify(value))
} = {}) {
  try {
    const config = parseArgs(args);
    if (config.selfTest) {
      const report = analyzeHttp(Array.from({ length: 20 }, () => ({
        httpStatus: 500, totalDuration: 10, path: '/api/health'
      })), 0);
      log(report);
      return report.status === 'stop' && report.stopReasons.includes('HTTP_5XX') ? 2 : 1;
    }
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    const lines = [];
    for await (const line of reader) {
      if (!line.trim()) continue;
      const parsed = parseJson(line);
      if (parsed) lines.push(parsed);
    }
    const report = config.mode === 'http'
      ? analyzeHttp(lines, config.expected409) : analyzeApplication(lines, config.expectedRevision);
    log(report);
    return report.status === 'passed' ? 0 : 2;
  } catch (error) {
    log({ status: 'refused', reason: error.message || 'SETUP_FAILED' });
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { analyzeHttp, analyzeApplication, validApplicationEvent, parseArgs, main };

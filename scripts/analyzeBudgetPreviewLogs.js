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

function validUtc(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validHttpRecord(row) {
  return row && typeof row === 'object'
    && Number.isInteger(row.httpStatus)
    && row.httpStatus >= 100
    && row.httpStatus <= 599
    && typeof row.totalDuration === 'number'
    && Number.isFinite(row.totalDuration)
    && row.totalDuration >= 0
    && typeof row.path === 'string'
    && row.path.startsWith('/')
    && validUtc(row.timestamp);
}

function analyzeHttp(lines, expected409 = 0, malformedRecords = 0, expectedWindow = null) {
  const invalidHttpRecords = lines.filter(row => !validHttpRecord(row)).length;
  const allRows = lines.filter(validHttpRecord);
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
  const healthTimes = healthRows.map(row => Date.parse(row.timestamp)).sort((left, right) => left - right);
  const allTimes = allRows.map(row => Date.parse(row.timestamp)).sort((left, right) => left - right);
  const maxHealthGapMs = healthTimes.slice(1).reduce((maximum, timestamp, index) => (
    Math.max(maximum, timestamp - healthTimes[index])
  ), 0);
  let temporalCoverageComplete = null;
  if (expectedWindow) {
    const toleranceMs = 30000;
    temporalCoverageComplete = allTimes.length > 0
      && allTimes.every(timestamp => (
        timestamp >= expectedWindow.startMs && timestamp <= expectedWindow.endMs
      ))
      && healthTimes[0] <= expectedWindow.startMs + toleranceMs
      && healthTimes.at(-1) >= expectedWindow.endMs - toleranceMs
      && maxHealthGapMs <= toleranceMs;
  }
  const stopReasons = [];
  if (malformedRecords) stopReasons.push('MALFORMED_LOG_RECORDS');
  if (invalidHttpRecords) stopReasons.push('INVALID_HTTP_LOG_RECORDS');
  if (expectedWindow && !temporalCoverageComplete) {
    stopReasons.push('INCOMPLETE_HTTP_TIME_COVERAGE');
  }
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
    failures5xx, healthFailures, malformedRecords, invalidHttpRecords,
    expectedStartUtc: expectedWindow?.startUtc || null,
    expectedEndUtc: expectedWindow?.endUtc || null,
    temporalCoverageComplete, maxHealthGapMs,
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
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(event.correlationId)
    && ['completed', 'aborted'].includes(event.outcome)
    && ['GET', 'POST', 'PUT'].includes(event.method)
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

function parseExpectedStatuses(value) {
  if (typeof value !== 'string' || !value) throw new Error('EXPECTED_STATUSES_REQUIRED');
  const result = {};
  for (const item of value.split(',')) {
    const match = /^(\d{3}):(\d+)$/.exec(item);
    if (!match) throw new Error('EXPECTED_STATUSES_INVALID');
    const status = Number(match[1]);
    const count = Number(match[2]);
    if (status < 100 || status > 599 || count > 10000 || Object.hasOwn(result, status)) {
      throw new Error('EXPECTED_STATUSES_INVALID');
    }
    result[status] = count;
  }
  return result;
}

function parseExpectedWindow(startUtc, endUtc) {
  if (!validUtc(startUtc) || !validUtc(endUtc)) throw new Error('HTTP_WINDOW_INVALID');
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (endMs <= startMs) throw new Error('HTTP_WINDOW_INVALID');
  return { startUtc, endUtc, startMs, endMs };
}

function analyzeApplication(lines, expectedRevision, expectedStatuses = {}, malformedRecords = 0) {
  const parsedEvents = lines.map(applicationEvent);
  const unreadableApplicationRecords = parsedEvents.filter(event => !event).length;
  const totalMalformedRecords = malformedRecords + unreadableApplicationRecords;
  const events = parsedEvents.filter(Boolean);
  const unsafeFields = [...new Set(events.flatMap(event => Object.keys(event)
    .filter(key => !SAFE_EVENT_FIELDS.has(key))))].sort();
  const missingFields = [...new Set(events.flatMap(event => [...SAFE_EVENT_FIELDS]
    .filter(key => !Object.hasOwn(event, key))))].sort();
  const invalidEvents = events.filter(event => !validApplicationEvent(event, expectedRevision)).length;
  const invalidRevisions = events.filter(event => event.revision !== expectedRevision).length;
  const correlationIds = events.map(event => event.correlationId);
  const duplicateCorrelationIds = [...new Set(correlationIds.filter((id, index) => (
    correlationIds.indexOf(id) !== index
  )))].sort();
  const actualStatuses = events.reduce((counts, event) => {
    const status = String(event.status);
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  const statusKeys = new Set([...Object.keys(expectedStatuses), ...Object.keys(actualStatuses)]);
  const statusMismatches = [...statusKeys].filter(status => (
    (expectedStatuses[status] || 0) !== (actualStatuses[status] || 0)
  )).sort();
  const stopReasons = [];
  if (totalMalformedRecords) stopReasons.push('MALFORMED_LOG_RECORDS');
  if (!events.length) stopReasons.push('NO_BUDGET_EVENTS');
  if (unsafeFields.length) stopReasons.push('UNSAFE_EVENT_FIELDS');
  if (missingFields.length) stopReasons.push('MISSING_EVENT_FIELDS');
  if (invalidRevisions) stopReasons.push('UNAUTHORIZED_EVENT_REVISION');
  if (invalidEvents) stopReasons.push('INVALID_EVENT_CONTRACT');
  if (duplicateCorrelationIds.length) stopReasons.push('DUPLICATE_CORRELATION_IDS');
  if (statusMismatches.length) stopReasons.push('EVENT_STATUS_MISMATCH');
  return { kind: 'application', status: stopReasons.length ? 'stop' : 'passed',
    events: events.length, expectedRevision, unsafeFields, missingFields,
    invalidEvents, invalidRevisions, malformedRecords: totalMalformedRecords,
    unreadableApplicationRecords, duplicateCorrelationIds,
    expectedStatuses, actualStatuses, statusMismatches,
    alert: stopReasons.length ? 'BUDGET_PREVIEW_STOP' : null, stopReasons };
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test-alert') return { selfTest: true };
  if (!['--http', '--application'].includes(args[0])) throw new Error('MODE_REQUIRED');
  if (args[0] === '--application') {
    if (args.length !== 5 || args[1] !== '--expected-revision'
      || !/^[0-9a-f]{40}$/i.test(args[2]) || args[3] !== '--expected-statuses') {
      throw new Error('APPLICATION_EXPECTATIONS_REQUIRED');
    }
    return { mode: 'application', expectedRevision: args[2].toLowerCase(),
      expectedStatuses: parseExpectedStatuses(args[4]) };
  }
  if (args[0] === '--http') {
    if (args.length !== 7 || args[1] !== '--expected-409' || !/^\d+$/.test(args[2])
      || args[3] !== '--start-utc' || args[5] !== '--end-utc') {
      throw new Error('HTTP_EXPECTATIONS_REQUIRED');
    }
    return { mode: 'http', expected409: Number(args[2]),
      expectedWindow: parseExpectedWindow(args[4], args[6]) };
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
        httpStatus: 500, totalDuration: 10, path: '/api/health',
        timestamp: '2026-09-06T00:00:00.000Z'
      })), 0);
      log(report);
      return report.status === 'stop' && report.stopReasons.includes('HTTP_5XX') ? 2 : 1;
    }
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    const lines = [];
    let malformedRecords = 0;
    for await (const line of reader) {
      if (!line.trim()) continue;
      const parsed = parseJson(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lines.push(parsed);
      else malformedRecords += 1;
    }
    const report = config.mode === 'http'
      ? analyzeHttp(lines, config.expected409, malformedRecords, config.expectedWindow)
      : analyzeApplication(lines, config.expectedRevision, config.expectedStatuses, malformedRecords);
    log(report);
    return report.status === 'passed' ? 0 : 2;
  } catch (error) {
    log({ status: 'refused', reason: error.message || 'SETUP_FAILED' });
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { analyzeHttp, analyzeApplication, validApplicationEvent,
  validHttpRecord, parseExpectedStatuses, parseExpectedWindow, parseArgs, main };

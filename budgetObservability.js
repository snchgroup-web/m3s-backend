const crypto = require('crypto');

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DRAFT_ID = /^\/[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const BUDGET_ROUTE_PREFIX = '/api/finance/budget-drafts';

function isBudgetRoute(pathname) {
  const path = String(pathname || '/').split('?')[0].toLowerCase();
  return path === BUDGET_ROUTE_PREFIX || path.startsWith(`${BUDGET_ROUTE_PREFIX}/`);
}

function normalizeBudgetRoute(pathname) {
  const path = String(pathname || '/').split('?')[0];
  const untrimmedLocalPath = isBudgetRoute(path) ? path.slice(BUDGET_ROUTE_PREFIX.length) || '/' : path;
  const localPath = untrimmedLocalPath.length > 1
    ? untrimmedLocalPath.replace(/\/+$/, '') : untrimmedLocalPath;
  if (localPath === '/' || localPath === '') return BUDGET_ROUTE_PREFIX;
  if (localPath.toLowerCase() === '/capabilities') return `${BUDGET_ROUTE_PREFIX}/capabilities`;
  if (DRAFT_ID.test(localPath)) return `${BUDGET_ROUTE_PREFIX}/:id`;
  return `${BUDGET_ROUTE_PREFIX}/:invalid`;
}

function createBudgetObservabilityMiddleware({
  logger = console,
  revision = 'local',
  now = () => Date.now(),
  idGenerator = () => crypto.randomUUID()
} = {}) {
  return (req, res, next) => {
    const startedAt = now();
    const correlationId = idGenerator();
    let businessCode = null;
    let recorded = false;
    const originalJson = res.json.bind(res);
    res.set('X-Request-Id', correlationId);
    res.json = body => {
      if (body && typeof body === 'object' && SAFE_CODE.test(String(body.code || ''))) {
        businessCode = body.code;
      }
      return originalJson(body);
    };
    const record = outcome => {
      if (recorded) return;
      recorded = true;
      const aborted = outcome === 'aborted';
      const status = aborted ? 499 : Number(res.statusCode) || 500;
      const finishedAt = now();
      const event = {
        event: 'budget_request',
        timestamp: new Date(finishedAt).toISOString(),
        correlationId,
        outcome,
        method: String(req.method || 'UNKNOWN').toUpperCase(),
        route: normalizeBudgetRoute(req.path || req.url),
        status,
        durationMs: Math.max(0, finishedAt - startedAt),
        code: aborted ? 'CLIENT_CLOSED_REQUEST' : businessCode,
        revision
      };
      const level = status >= 500 ? 'error' : status === 409 || aborted ? 'warn' : 'info';
      const write = typeof logger[level] === 'function' ? logger[level] : logger.log;
      if (typeof write === 'function') write.call(logger, JSON.stringify(event));
    };
    res.once('finish', () => record('completed'));
    res.once('close', () => record(res.writableFinished ? 'completed' : 'aborted'));
    next();
  };
}

module.exports = { isBudgetRoute, normalizeBudgetRoute, createBudgetObservabilityMiddleware };

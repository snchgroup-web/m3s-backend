const { validateBudgetV2 } = require('./financeBudgetV2Contracts');

const REFERENCE_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_YEAR_PATTERN = /^\d{4}$/;
const IANA_TIMEZONE_MAX_LENGTH = 64;

const REFERENCE_TYPES = Object.freeze([
  'entity', 'fiscalYear', 'function', 'team', 'agent', 'country',
  'portfolio', 'dossier', 'project', 'phase'
]);
const OPERATIONS = Object.freeze({ WRITE: 'write', READ: 'read' });
const CONFIDENTIALITIES = new Set(['public', 'internal', 'restricted']);

const DIMENSION_TYPES = Object.freeze({
  functionId: 'function',
  teamId: 'team',
  agentId: 'agent',
  countryId: 'country',
  portfolioId: 'portfolio',
  dossierId: 'dossier',
  projectId: 'project',
  phaseId: 'phase'
});
const PERIOD_KEYS = Object.freeze(['periodId', 'ordinal', 'startDate', 'endDate']);

class BudgetReferenceError extends Error {
  constructor(code) {
    super('Budget reference resolution failed');
    this.name = 'BudgetReferenceError';
    this.code = code;
  }
}

const fail = code => { throw new BudgetReferenceError(code); };

function isReferenceId(value) {
  return typeof value === 'string' && REFERENCE_ID_PATTERN.test(value)
    && Boolean(value.trim());
}

function isIsoDate(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(RFC3339_UTC_PATTERN);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const milliseconds = (match[7] || '').padEnd(3, '0');
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`;
  return new Date(value).toISOString() === canonical;
}

function isBoundedText(value, maximum) {
  return typeof value === 'string' && Array.from(value).length <= maximum
    && Boolean(value.trim());
}

function hasExactFields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function isTimezone(value) {
  if (!isBoundedText(value, IANA_TIMEZONE_MAX_LENGTH)) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date(0));
    return true;
  } catch (_error) {
    return false;
  }
}

function addUtcDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function addUtcMonth(value) {
  const [year, month, day] = value.split('-').map(Number);
  const targetMonthStart = new Date(Date.UTC(year, month, 1));
  const targetYear = targetMonthStart.getUTCFullYear();
  const targetMonth = targetMonthStart.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)))
    .toISOString().slice(0, 10);
}

function dateInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function validateContext(context) {
  if (!context || !isReferenceId(context.tenantId) || !isReferenceId(context.actorId)
    || !Object.values(OPERATIONS).includes(context.operation)) {
    fail('BUDGET_REQUEST_INVALID');
  }
}

function validateResolverResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.available !== 'boolean') {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  if (!result.available) fail('BUDGET_REFERENCE_UNAVAILABLE');
  if (!Array.isArray(result.records)) fail('BUDGET_REFERENCE_UNAVAILABLE');
}

function validateBaseRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !isReferenceId(record.id) || !isReferenceId(record.tenantId)
    || !isReferenceId(record.status) || !isUtcTimestamp(record.effectiveFrom)
    || (record.effectiveTo !== null && !isUtcTimestamp(record.effectiveTo))
    || !isBoundedText(record.labelSnapshot, 200)
    || !isReferenceId(record.sourceRevision)
    || !CONFIDENTIALITIES.has(record.confidentiality)
    || typeof record.visible !== 'boolean') {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  if (record.effectiveTo !== null
    && Date.parse(record.effectiveTo) <= Date.parse(record.effectiveFrom)) {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
}

function stateCode(type, purpose) {
  if (type === 'fiscalYear') return 'BUDGET_FISCAL_YEAR_INVALID';
  if (type === 'agent' && purpose === 'responsibility') {
    return 'BUDGET_RESPONSIBILITY_INVALID';
  }
  return 'BUDGET_REFERENCE_STATE_INVALID';
}

function acceptedStatus(record, type, operation, purpose, at) {
  if (type === 'entity') return record.status === 'active';
  if (type === 'fiscalYear') {
    if (operation === OPERATIONS.READ) {
      return ['planned', 'open', 'closed'].includes(record.status);
    }
    const localDate = dateInTimezone(at, record.timezone);
    return (record.status === 'planned' && localDate < record.startDate)
      || (record.status === 'open' && localDate >= record.startDate && localDate <= record.endDate);
  }
  if (type === 'project' || type === 'phase') {
    if (['planned', 'active', 'open'].includes(record.status)) return true;
    return operation === OPERATIONS.READ && ['completed', 'closed'].includes(record.status)
      && record.historicalVisible === true;
  }
  if (type === 'agent' && purpose === 'responsibility') {
    if (record.status === 'active') return true;
    return operation === OPERATIONS.READ && record.status === 'archived'
      && record.historicalVisible === true;
  }
  if (record.status === 'active') return true;
  return operation === OPERATIONS.READ && record.status === 'archived'
    && record.historicalVisible === true;
}

function validateFiscalYear(record) {
  if (!isReferenceId(record.entityId)
    || !SUMMARY_YEAR_PATTERN.test(record.summaryYear)
    || !isIsoDate(record.startDate) || !isIsoDate(record.endDate)
    || record.startDate > record.endDate || record.periodicity !== 'monthly'
    || !isTimezone(record.timezone) || !Array.isArray(record.periods)
    || record.periods.length !== 12) {
    fail('BUDGET_FISCAL_YEAR_INVALID');
  }

  const periodIds = new Set();
  const ordinals = new Set();
  for (const period of record.periods) {
    if (!hasExactFields(period, PERIOD_KEYS)
      || !isReferenceId(period.periodId) || periodIds.has(period.periodId)
      || !Number.isInteger(period.ordinal) || period.ordinal < 1 || period.ordinal > 12
      || ordinals.has(period.ordinal) || !isIsoDate(period.startDate)
      || !isIsoDate(period.endDate) || period.startDate > period.endDate) {
      fail('BUDGET_FISCAL_YEAR_INVALID');
    }
    periodIds.add(period.periodId);
    ordinals.add(period.ordinal);
  }

  const ordered = [...record.periods].sort((left, right) => left.ordinal - right.ordinal);
  if (ordered[0].startDate !== record.startDate
    || ordered[ordered.length - 1].endDate !== record.endDate) {
    fail('BUDGET_FISCAL_YEAR_INVALID');
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].startDate !== addUtcDay(ordered[index - 1].endDate)) {
      fail('BUDGET_FISCAL_YEAR_INVALID');
    }
  }
  for (const period of ordered) {
    const nextMonth = addUtcMonth(period.startDate);
    const expectedEnd = new Date(`${nextMonth}T00:00:00Z`);
    expectedEnd.setUTCDate(expectedEnd.getUTCDate() - 1);
    if (period.endDate !== expectedEnd.toISOString().slice(0, 10)) {
      fail('BUDGET_FISCAL_YEAR_INVALID');
    }
  }
}

function validateTypeRecord(record, type, purpose) {
  if (type === 'fiscalYear') validateFiscalYear(record);
  if (type === 'portfolio' && !isReferenceId(record.functionId)) {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  if (type === 'dossier' && !isReferenceId(record.portfolioId)) {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  if (type === 'project' && !isReferenceId(record.dossierId)) {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  if (type === 'phase' && !isReferenceId(record.projectId)) {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  if (type === 'agent') {
    if (!isReferenceId(record.teamId)) fail('BUDGET_REFERENCE_UNAVAILABLE');
    if (purpose === 'responsibility') {
      const expected = record.responsibility;
      if (!Array.isArray(record.allowedResponsibilities)
        || !record.allowedResponsibilities.includes(expected)) {
        fail('BUDGET_RESPONSIBILITY_INVALID');
      }
    }
  }
}

function baseSnapshot(record, resolvedAt) {
  return {
    id: record.id,
    labelSnapshot: record.labelSnapshot,
    statusSnapshot: record.status,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    sourceRevision: record.sourceRevision,
    resolvedAt
  };
}

function typedSnapshot(record, type, resolvedAt) {
  const snapshot = baseSnapshot(record, resolvedAt);
  if (type === 'fiscalYear') {
    return {
      ...snapshot,
      entityId: record.entityId,
      summaryYear: record.summaryYear,
      startDate: record.startDate,
      endDate: record.endDate,
      periodicity: record.periodicity,
      timezone: record.timezone,
      periods: record.periods
        .map(period => ({
          periodId: period.periodId,
          ordinal: period.ordinal,
          startDate: period.startDate,
          endDate: period.endDate
        }))
        .sort((left, right) => left.ordinal - right.ordinal)
    };
  }
  if (type === 'agent') return { ...snapshot, teamId: record.teamId };
  if (type === 'portfolio') return { ...snapshot, functionId: record.functionId };
  if (type === 'dossier') return { ...snapshot, portfolioId: record.portfolioId };
  if (type === 'project') return { ...snapshot, dossierId: record.dossierId };
  if (type === 'phase') return { ...snapshot, projectId: record.projectId };
  return snapshot;
}

// Each injected resolver returns { available, records }; all returned data stays untrusted here.
function createBudgetReferenceService({ resolvers = {}, canAccessRestricted, clock } = {}) {
  const now = typeof clock === 'function' ? clock : () => new Date();
  const restrictedPolicy = typeof canAccessRestricted === 'function'
    ? canAccessRestricted
    : () => false;

  async function resolveBudgetReferences({ budget, tenantId, actorId, operation = OPERATIONS.WRITE }) {
    validateBudgetV2(budget);
    validateContext({ tenantId, actorId, operation });
    const at = now();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail('BUDGET_REFERENCE_UNAVAILABLE');
    const resolvedAt = at.toISOString();
    const cache = new Map();

    async function resolve(type, id, purpose = 'dimension', responsibility = null) {
      const cacheKey = `${type}\u0000${id}`;
      let value = cache.get(cacheKey);
      if (!value) {
        const resolver = resolvers[type];
        if (typeof resolver !== 'function') fail('BUDGET_REFERENCE_UNAVAILABLE');

        let result;
        try {
          result = await resolver({ id, tenantId, actorId, operation, resolvedAt });
        } catch (_error) {
          fail('BUDGET_REFERENCE_UNAVAILABLE');
        }
        validateResolverResult(result);
        if (result.records.length !== 1) fail('BUDGET_REFERENCE_NOT_FOUND');
        const record = result.records[0];
        validateBaseRecord(record);
        if (record.id !== id || record.tenantId !== tenantId || !record.visible) {
          fail('BUDGET_REFERENCE_NOT_FOUND');
        }
        if (record.confidentiality === 'restricted') {
          let allowed = false;
          try {
            allowed = restrictedPolicy({ type, record, tenantId, actorId, operation }) === true;
          } catch (_error) {
            fail('BUDGET_REFERENCE_UNAVAILABLE');
          }
          if (!allowed) fail('BUDGET_REFERENCE_NOT_FOUND');
        }
        if (Date.parse(record.effectiveFrom) > at.getTime()
          || (record.effectiveTo !== null && Date.parse(record.effectiveTo) <= at.getTime())) {
          fail(stateCode(type, purpose));
        }
        value = { record, snapshot: null };
        cache.set(cacheKey, value);
      }

      const { record } = value;
      const recordForValidation = responsibility
        ? { ...record, responsibility }
        : record;
      validateTypeRecord(recordForValidation, type, purpose);
      if (!acceptedStatus(recordForValidation, type, operation, purpose, at)) {
        fail(stateCode(type, purpose));
      }
      if (value.snapshot === null) value.snapshot = typedSnapshot(record, type, resolvedAt);
      return value;
    }

    const entity = await resolve('entity', budget.identity.entityId, 'identity');
    const fiscalYear = await resolve('fiscalYear', budget.identity.fiscalYearId, 'identity');
    if (fiscalYear.record.entityId !== entity.record.id) {
      fail('BUDGET_REFERENCE_RELATION_INVALID');
    }

    const owner = await resolve(
      'agent', budget.responsibilities.budgetOwnerAgentId,
      'responsibility', 'budgetOwnerAgentId'
    );
    const controller = budget.responsibilities.controllerAgentId === null
      ? null
      : await resolve(
        'agent', budget.responsibilities.controllerAgentId,
        'responsibility', 'controllerAgentId'
      );

    const expectedPeriodIds = new Set(fiscalYear.record.periods.map(period => period.periodId));
    const rows = [];
    for (const row of budget.rows) {
      const actualPeriodIds = new Set(row.periodValues.map(period => period.periodId));
      if (actualPeriodIds.size !== expectedPeriodIds.size
        || [...expectedPeriodIds].some(id => !actualPeriodIds.has(id))) {
        fail('BUDGET_FISCAL_YEAR_INVALID');
      }

      const dimensions = {};
      const records = {};
      for (const [key, type] of Object.entries(DIMENSION_TYPES)) {
        if (row.dimensions[key] === null) {
          dimensions[key] = null;
          records[key] = null;
        } else {
          const resolved = await resolve(type, row.dimensions[key]);
          dimensions[key] = resolved.snapshot;
          records[key] = resolved.record;
        }
      }

      if (records.portfolioId
        && (!records.functionId || records.portfolioId.functionId !== records.functionId.id)) {
        fail('BUDGET_REFERENCE_RELATION_INVALID');
      }
      if (records.dossierId
        && (!records.portfolioId || records.dossierId.portfolioId !== records.portfolioId.id)) {
        fail('BUDGET_REFERENCE_RELATION_INVALID');
      }
      if (records.projectId
        && (!records.dossierId || records.projectId.dossierId !== records.dossierId.id)) {
        fail('BUDGET_REFERENCE_RELATION_INVALID');
      }
      if (records.phaseId
        && (!records.projectId || records.phaseId.projectId !== records.projectId.id)) {
        fail('BUDGET_REFERENCE_RELATION_INVALID');
      }
      if (records.agentId
        && records.teamId && records.agentId.teamId !== records.teamId.id) {
        fail('BUDGET_REFERENCE_RELATION_INVALID');
      }
      rows.push({ rowId: row.id, dimensions });
    }

    return {
      identity: {
        entityId: entity.snapshot,
        fiscalYearId: fiscalYear.snapshot
      },
      responsibilities: {
        budgetOwnerAgentId: owner.snapshot,
        controllerAgentId: controller ? controller.snapshot : null
      },
      rows
    };
  }

  return Object.freeze({ resolveBudgetReferences });
}

module.exports = {
  BudgetReferenceError,
  DIMENSION_TYPES,
  OPERATIONS,
  REFERENCE_TYPES,
  createBudgetReferenceService
};

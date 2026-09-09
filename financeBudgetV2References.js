const { validateBudgetV2 } = require('./financeBudgetV2Contracts');

const REFERENCE_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_YEAR_PATTERN = /^\d{4}$/;
const IANA_TIMEZONE_MAX_LENGTH = 64;

const REFERENCE_TYPES = Object.freeze([
  'entity', 'fiscalYear', 'function', 'team', 'agent', 'country',
  'portfolio', 'dossier', 'project', 'phase'
]);
const OPERATIONS = Object.freeze({ WRITE: 'write', READ: 'read' });
const MAX_DETAIL_REFERENCE_PAIRS = 804;
const MAX_LIST_REFERENCE_RESOLUTIONS = 4096;
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
  const parsed = new Date(value);
  return parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() + 1 === Number(match[2])
    && parsed.getUTCDate() === Number(match[3])
    && parsed.getUTCHours() === Number(match[4])
    && parsed.getUTCMinutes() === Number(match[5])
    && parsed.getUTCSeconds() === Number(match[6]);
}

function compareUtcTimestamps(left, right) {
  const leftMatch = left.match(RFC3339_UTC_PATTERN);
  const rightMatch = right.match(RFC3339_UTC_PATTERN);
  const leftBase = left.slice(0, 19);
  const rightBase = right.slice(0, 19);
  if (leftBase !== rightBase) return leftBase < rightBase ? -1 : 1;
  const leftFraction = (leftMatch[7] || '').replace(/0+$/, '');
  const rightFraction = (rightMatch[7] || '').replace(/0+$/, '');
  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftPadded = leftFraction.padEnd(width, '0');
  const rightPadded = rightFraction.padEnd(width, '0');
  if (leftPadded === rightPadded) return 0;
  return leftPadded < rightPadded ? -1 : 1;
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
    && compareUtcTimestamps(record.effectiveTo, record.effectiveFrom) <= 0) {
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

function acceptedLifecycleStatus(record, type, operation, purpose) {
  if (type === 'entity') return record.status === 'active';
  if (type === 'fiscalYear') {
    return operation === OPERATIONS.READ
      ? ['planned', 'open', 'closed'].includes(record.status)
      : ['planned', 'open'].includes(record.status);
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

function validateFiscalYear(record, operation, at) {
  if (typeof record.summaryYear !== 'string' || !SUMMARY_YEAR_PATTERN.test(record.summaryYear)
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
  if (operation === OPERATIONS.WRITE) {
    const localDate = dateInTimezone(at, record.timezone);
    const validForWrite = (record.status === 'planned' && localDate < record.startDate)
      || (record.status === 'open' && localDate >= record.startDate && localDate <= record.endDate);
    if (!validForWrite) fail('BUDGET_FISCAL_YEAR_INVALID');
  }
}

function validateSourceRecord(record, type) {
  if (type === 'fiscalYear' && !isReferenceId(record.entityId)) {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
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
  }
}

function validateTypeRecord(record, type, purpose, operation, at) {
  if (type === 'fiscalYear') validateFiscalYear(record, operation, at);
  if (type === 'agent' && purpose === 'responsibility') {
    const expected = record.responsibility;
    if (!Array.isArray(record.allowedResponsibilities)
      || !record.allowedResponsibilities.includes(expected)) {
      fail('BUDGET_RESPONSIBILITY_INVALID');
    }
  }
}

function collectRequirements(budget) {
  const requirements = [
    { type: 'entity', id: budget.identity.entityId, purpose: 'identity' },
    { type: 'fiscalYear', id: budget.identity.fiscalYearId, purpose: 'identity' },
    {
      type: 'agent', id: budget.responsibilities.budgetOwnerAgentId,
      purpose: 'responsibility', responsibility: 'budgetOwnerAgentId'
    }
  ];
  if (budget.responsibilities.controllerAgentId !== null) {
    requirements.push({
      type: 'agent', id: budget.responsibilities.controllerAgentId,
      purpose: 'responsibility', responsibility: 'controllerAgentId'
    });
  }
  for (const row of budget.rows) {
    for (const [key, type] of Object.entries(DIMENSION_TYPES)) {
      if (row.dimensions[key] !== null) {
        requirements.push({ type, id: row.dimensions[key], purpose: 'dimension' });
      }
    }
  }
  return requirements;
}

function extractStoredRequirements(rawBudget) {
  if (!rawBudget || typeof rawBudget !== 'object' || Array.isArray(rawBudget)
    || !rawBudget.identity || typeof rawBudget.identity !== 'object'
    || Array.isArray(rawBudget.identity)
    || !isReferenceId(rawBudget.identity.entityId)
    || !isReferenceId(rawBudget.identity.fiscalYearId)
    || !rawBudget.responsibilities || typeof rawBudget.responsibilities !== 'object'
    || Array.isArray(rawBudget.responsibilities)
    || !isReferenceId(rawBudget.responsibilities.budgetOwnerAgentId)
    || (rawBudget.responsibilities.controllerAgentId !== null
      && !isReferenceId(rawBudget.responsibilities.controllerAgentId))
    || !Array.isArray(rawBudget.rows)) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }

  const requirements = [
    { type: 'entity', id: rawBudget.identity.entityId, purpose: 'identity' },
    { type: 'fiscalYear', id: rawBudget.identity.fiscalYearId, purpose: 'identity' },
    {
      type: 'agent', id: rawBudget.responsibilities.budgetOwnerAgentId,
      purpose: 'responsibility', responsibility: 'budgetOwnerAgentId'
    }
  ];
  if (rawBudget.responsibilities.controllerAgentId !== null) {
    requirements.push({
      type: 'agent', id: rawBudget.responsibilities.controllerAgentId,
      purpose: 'responsibility', responsibility: 'controllerAgentId'
    });
  }

  const uniquePairs = new Set(requirements.map(item => `${item.type}\u0000${item.id}`));
  for (const row of rawBudget.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || !row.dimensions || typeof row.dimensions !== 'object'
      || Array.isArray(row.dimensions) || !Array.isArray(row.periodValues)) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    for (const periodValue of row.periodValues) {
      if (!periodValue || typeof periodValue !== 'object' || Array.isArray(periodValue)
        || !isReferenceId(periodValue.periodId)) {
        fail('BUDGET_STORAGE_UNAVAILABLE');
      }
    }
    for (const [key, type] of Object.entries(DIMENSION_TYPES)) {
      if (!Object.hasOwn(row.dimensions, key)) fail('BUDGET_STORAGE_UNAVAILABLE');
      const id = row.dimensions[key];
      if (id === null) continue;
      if (!isReferenceId(id)) fail('BUDGET_STORAGE_UNAVAILABLE');
      requirements.push({ type, id, purpose: 'dimension' });
      uniquePairs.add(`${type}\u0000${id}`);
      if (uniquePairs.size > MAX_DETAIL_REFERENCE_PAIRS) {
        fail('BUDGET_STORAGE_UNAVAILABLE');
      }
    }
  }
  return requirements;
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
  const storedCache = new Map();
  let storedContextKey = null;

  async function resolveBudgetReferences({ budget, tenantId, actorId, operation = OPERATIONS.WRITE }) {
    validateBudgetV2(budget);
    validateContext({ tenantId, actorId, operation });
    const at = now();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail('BUDGET_REFERENCE_UNAVAILABLE');
    const resolvedAt = at.toISOString();
    const cache = new Map();
    const requirements = collectRequirements(budget);

    const preflightErrors = [];
    const uniqueRequirementsByKey = new Map();
    for (const item of requirements) {
      const key = `${item.type}\u0000${item.id}`;
      if (!uniqueRequirementsByKey.has(key)) uniqueRequirementsByKey.set(key, item);
    }
    const uniqueRequirements = [...uniqueRequirementsByKey.values()];
    for (const { type, id } of uniqueRequirements) {
      try {
        const resolver = resolvers[type];
        if (typeof resolver !== 'function') fail('BUDGET_REFERENCE_UNAVAILABLE');
        let result;
        try {
          result = await resolver({ id, tenantId, actorId, operation, resolvedAt });
        } catch (_error) {
          fail('BUDGET_REFERENCE_UNAVAILABLE');
        }
        validateResolverResult(result);
        if (result.records.length === 0) fail('BUDGET_REFERENCE_NOT_FOUND');
        if (result.records.length > 1) fail('BUDGET_REFERENCE_UNAVAILABLE');
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
        validateSourceRecord(record, type);
        cache.set(`${type}\u0000${id}`, { record, snapshot: null });
      } catch (error) {
        preflightErrors.push(error instanceof BudgetReferenceError
          ? error.code
          : 'BUDGET_REFERENCE_UNAVAILABLE');
      }
    }
    if (preflightErrors.includes('BUDGET_REFERENCE_UNAVAILABLE')) {
      fail('BUDGET_REFERENCE_UNAVAILABLE');
    }
    if (preflightErrors.includes('BUDGET_REFERENCE_NOT_FOUND')) {
      fail('BUDGET_REFERENCE_NOT_FOUND');
    }

    function cached(type, id) {
      const value = cache.get(`${type}\u0000${id}`);
      if (!value) fail('BUDGET_REFERENCE_UNAVAILABLE');
      return value;
    }

    const lifecycleErrors = new Set();
    for (const { type, id, purpose } of requirements) {
      const { record } = cached(type, id);
      if (compareUtcTimestamps(record.effectiveFrom, resolvedAt) > 0
        || (record.effectiveTo !== null
          && compareUtcTimestamps(record.effectiveTo, resolvedAt) <= 0)) {
        lifecycleErrors.add(stateCode(type, purpose));
        continue;
      }
      if (!acceptedLifecycleStatus(record, type, operation, purpose)) {
        lifecycleErrors.add(stateCode(type, purpose));
      }
    }
    for (const code of [
      'BUDGET_REFERENCE_STATE_INVALID',
      'BUDGET_FISCAL_YEAR_INVALID',
      'BUDGET_RESPONSIBILITY_INVALID'
    ]) {
      if (lifecycleErrors.has(code)) fail(code);
    }

    const entity = cached('entity', budget.identity.entityId);
    const fiscalYear = cached('fiscalYear', budget.identity.fiscalYearId);
    validateTypeRecord(fiscalYear.record, 'fiscalYear', 'identity', operation, at);

    const expectedPeriodIds = new Set(fiscalYear.record.periods.map(period => period.periodId));
    for (const row of budget.rows) {
      const actualPeriodIds = new Set(row.periodValues.map(period => period.periodId));
      if (actualPeriodIds.size !== expectedPeriodIds.size
        || [...expectedPeriodIds].some(id => !actualPeriodIds.has(id))) {
        fail('BUDGET_FISCAL_YEAR_INVALID');
      }
    }

    const owner = cached('agent', budget.responsibilities.budgetOwnerAgentId);
    validateTypeRecord(
      { ...owner.record, responsibility: 'budgetOwnerAgentId' },
      'agent', 'responsibility', operation, at
    );
    const controller = budget.responsibilities.controllerAgentId === null
      ? null
      : cached('agent', budget.responsibilities.controllerAgentId);
    if (controller) {
      validateTypeRecord(
        { ...controller.record, responsibility: 'controllerAgentId' },
        'agent', 'responsibility', operation, at
      );
    }

    const resolvedRows = budget.rows.map(row => {
      const records = {};
      for (const [key, type] of Object.entries(DIMENSION_TYPES)) {
        records[key] = row.dimensions[key] === null
          ? null
          : cached(type, row.dimensions[key]).record;
      }
      return { rowId: row.id, records };
    });

    for (const { records } of resolvedRows) {
      if (records.agentId
        && records.teamId && records.agentId.teamId !== records.teamId.id) {
        fail('BUDGET_RESPONSIBILITY_INVALID');
      }
    }

    if (fiscalYear.record.entityId !== entity.record.id) {
      fail('BUDGET_REFERENCE_RELATION_INVALID');
    }
    for (const { records } of resolvedRows) {
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
    }

    function snapshot(type, id) {
      const value = cached(type, id);
      if (value.snapshot === null) value.snapshot = typedSnapshot(value.record, type, resolvedAt);
      return value.snapshot;
    }

    const rows = budget.rows.map((row, rowIndex) => {
      const dimensions = {};
      for (const [key, type] of Object.entries(DIMENSION_TYPES)) {
        dimensions[key] = row.dimensions[key] === null
          ? null
          : snapshot(type, row.dimensions[key]);
      }
      return { rowId: resolvedRows[rowIndex].rowId, dimensions };
    });

    return {
      identity: {
        entityId: snapshot('entity', budget.identity.entityId),
        fiscalYearId: snapshot('fiscalYear', budget.identity.fiscalYearId)
      },
      responsibilities: {
        budgetOwnerAgentId: snapshot('agent', budget.responsibilities.budgetOwnerAgentId),
        controllerAgentId: controller
          ? snapshot('agent', budget.responsibilities.controllerAgentId)
          : null
      },
      rows
    };
  }

  async function resolveStoredBudgetReferences({
    rawBudget, tenantId, actorId, operation, resolvedAt
  } = {}) {
    validateContext({ tenantId, actorId, operation });
    if (operation !== OPERATIONS.READ || !(resolvedAt instanceof Date)
      || !Number.isFinite(resolvedAt.getTime())) {
      fail('BUDGET_REQUEST_INVALID');
    }
    const at = new Date(resolvedAt.getTime());
    const resolvedAtIso = at.toISOString();
    const contextKey = `${tenantId}\u0000${actorId}\u0000${operation}\u0000${resolvedAtIso}`;
    if (storedContextKey === null) storedContextKey = contextKey;
    if (storedContextKey !== contextKey) fail('BUDGET_REQUEST_INVALID');

    const requirements = extractStoredRequirements(rawBudget);
    const uniqueRequirementsByKey = new Map();
    for (const item of requirements) {
      const key = `${item.type}\u0000${item.id}`;
      if (!uniqueRequirementsByKey.has(key)) uniqueRequirementsByKey.set(key, item);
    }

    const preflightErrors = [];
    const draftEntries = new Map();
    for (const [key, { type, id }] of uniqueRequirementsByKey) {
      if (!storedCache.has(key)) {
        if (storedCache.size >= MAX_LIST_REFERENCE_RESOLUTIONS) {
          fail('BUDGET_STORAGE_UNAVAILABLE');
        }
        const pendingEntry = Promise.resolve().then(async () => {
          try {
            const resolver = resolvers[type];
            if (typeof resolver !== 'function') fail('BUDGET_REFERENCE_UNAVAILABLE');
            let result;
            try {
              result = await resolver({
                id, tenantId, actorId, operation, resolvedAt: resolvedAtIso
              });
            } catch (_error) {
              fail('BUDGET_REFERENCE_UNAVAILABLE');
            }
            validateResolverResult(result);
            if (result.records.length === 0) fail('BUDGET_REFERENCE_NOT_FOUND');
            if (result.records.length > 1) fail('BUDGET_REFERENCE_UNAVAILABLE');
            let record;
            try {
              record = structuredClone(result.records[0]);
            } catch (_error) {
              fail('BUDGET_REFERENCE_UNAVAILABLE');
            }
            validateBaseRecord(record);
            if (record.id !== id || record.tenantId !== tenantId || !record.visible) {
              fail('BUDGET_REFERENCE_NOT_FOUND');
            }
            if (record.confidentiality === 'restricted') {
              let allowed = false;
              try {
                allowed = restrictedPolicy({
                  type, record, tenantId, actorId, operation
                }) === true;
              } catch (_error) {
                fail('BUDGET_REFERENCE_UNAVAILABLE');
              }
              if (!allowed) fail('BUDGET_REFERENCE_NOT_FOUND');
            }
            validateSourceRecord(record, type);
            return { record, errorCode: null };
          } catch (error) {
            return {
              record: null,
              errorCode: error instanceof BudgetReferenceError
                ? error.code
                : 'BUDGET_REFERENCE_UNAVAILABLE'
            };
          }
        });
        storedCache.set(key, pendingEntry);
      }
      const entry = await storedCache.get(key);
      draftEntries.set(key, entry);
      if (entry.errorCode !== null) preflightErrors.push(entry.errorCode);
    }
    if (preflightErrors.includes('BUDGET_REFERENCE_UNAVAILABLE')) {
      fail('BUDGET_REFERENCE_UNAVAILABLE');
    }
    if (preflightErrors.includes('BUDGET_REFERENCE_NOT_FOUND')) {
      fail('BUDGET_REFERENCE_NOT_FOUND');
    }

    function cached(type, id) {
      const value = draftEntries.get(`${type}\u0000${id}`);
      if (!value || value.errorCode !== null || !value.record) {
        fail('BUDGET_REFERENCE_UNAVAILABLE');
      }
      return value;
    }

    const lifecycleErrors = new Set();
    for (const { type, id, purpose } of requirements) {
      const { record } = cached(type, id);
      if (compareUtcTimestamps(record.effectiveFrom, resolvedAtIso) > 0
        || (record.effectiveTo !== null
          && compareUtcTimestamps(record.effectiveTo, resolvedAtIso) <= 0)) {
        lifecycleErrors.add(stateCode(type, purpose));
        continue;
      }
      if (!acceptedLifecycleStatus(record, type, operation, purpose)) {
        lifecycleErrors.add(stateCode(type, purpose));
      }
    }
    for (const code of [
      'BUDGET_REFERENCE_STATE_INVALID',
      'BUDGET_FISCAL_YEAR_INVALID',
      'BUDGET_RESPONSIBILITY_INVALID'
    ]) {
      if (lifecycleErrors.has(code)) fail(code);
    }

    const entity = cached('entity', rawBudget.identity.entityId);
    const fiscalYear = cached('fiscalYear', rawBudget.identity.fiscalYearId);
    validateTypeRecord(fiscalYear.record, 'fiscalYear', 'identity', operation, at);

    const expectedPeriodIds = new Set(fiscalYear.record.periods.map(period => period.periodId));
    for (const row of rawBudget.rows) {
      const actualPeriodIds = new Set(row.periodValues.map(period => period.periodId));
      if (actualPeriodIds.size !== expectedPeriodIds.size
        || [...expectedPeriodIds].some(id => !actualPeriodIds.has(id))) {
        fail('BUDGET_FISCAL_YEAR_INVALID');
      }
    }

    const owner = cached('agent', rawBudget.responsibilities.budgetOwnerAgentId);
    validateTypeRecord(
      { ...owner.record, responsibility: 'budgetOwnerAgentId' },
      'agent', 'responsibility', operation, at
    );
    const controller = rawBudget.responsibilities.controllerAgentId === null
      ? null
      : cached('agent', rawBudget.responsibilities.controllerAgentId);
    if (controller) {
      validateTypeRecord(
        { ...controller.record, responsibility: 'controllerAgentId' },
        'agent', 'responsibility', operation, at
      );
    }

    const resolvedRows = rawBudget.rows.map(row => {
      const records = {};
      for (const [key, type] of Object.entries(DIMENSION_TYPES)) {
        records[key] = row.dimensions[key] === null
          ? null
          : cached(type, row.dimensions[key]).record;
      }
      return { rowId: row.id, records };
    });
    for (const { records } of resolvedRows) {
      if (records.agentId && records.teamId
        && records.agentId.teamId !== records.teamId.id) {
        fail('BUDGET_RESPONSIBILITY_INVALID');
      }
    }
    if (fiscalYear.record.entityId !== entity.record.id) {
      fail('BUDGET_REFERENCE_RELATION_INVALID');
    }
    for (const { records } of resolvedRows) {
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
    }

    validateBudgetV2(rawBudget);

    function snapshot(type, id) {
      return typedSnapshot(cached(type, id).record, type, resolvedAtIso);
    }
    const rows = rawBudget.rows.map((row, rowIndex) => {
      const dimensions = {};
      for (const [key, type] of Object.entries(DIMENSION_TYPES)) {
        dimensions[key] = row.dimensions[key] === null
          ? null
          : snapshot(type, row.dimensions[key]);
      }
      return { rowId: resolvedRows[rowIndex].rowId, dimensions };
    });
    return {
      identity: {
        entityId: snapshot('entity', rawBudget.identity.entityId),
        fiscalYearId: snapshot('fiscalYear', rawBudget.identity.fiscalYearId)
      },
      responsibilities: {
        budgetOwnerAgentId: snapshot('agent', rawBudget.responsibilities.budgetOwnerAgentId),
        controllerAgentId: controller
          ? snapshot('agent', rawBudget.responsibilities.controllerAgentId)
          : null
      },
      rows
    };
  }

  return Object.freeze({ resolveBudgetReferences, resolveStoredBudgetReferences });
}

module.exports = {
  BudgetReferenceError,
  DIMENSION_TYPES,
  MAX_DETAIL_REFERENCE_PAIRS,
  MAX_LIST_REFERENCE_RESOLUTIONS,
  OPERATIONS,
  REFERENCE_TYPES,
  createBudgetReferenceService
};

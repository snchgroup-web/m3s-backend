const { MAX_VERSION, validateBudgetV2 } = require('./financeBudgetV2Contracts');
const { DIMENSION_TYPES } = require('./financeBudgetV2References');

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const RECORD_KEYS = Object.freeze([
  'id', 'tenantId', 'authorUserId', 'version', 'title', 'entity', 'year',
  'createdAt', 'updatedAt', 'scope', 'status', 'access', 'document'
]);
const ROOT_KEYS = Object.freeze(['contractVersion', 'budget', 'referenceSnapshots']);
const SNAPSHOT_ROOT_KEYS = Object.freeze(['identity', 'responsibilities', 'rows']);
const IDENTITY_KEYS = Object.freeze(['entityId', 'fiscalYearId']);
const RESPONSIBILITY_KEYS = Object.freeze(['budgetOwnerAgentId', 'controllerAgentId']);
const SNAPSHOT_ROW_KEYS = Object.freeze(['rowId', 'dimensions']);
const DIMENSION_KEYS = Object.freeze(Object.keys(DIMENSION_TYPES));
const PERIOD_KEYS = Object.freeze(['periodId', 'ordinal', 'startDate', 'endDate']);
const BASE_SNAPSHOT_KEYS = Object.freeze([
  'id', 'labelSnapshot', 'statusSnapshot', 'effectiveFrom', 'effectiveTo',
  'sourceRevision', 'resolvedAt'
]);
const SNAPSHOT_EXTRA_KEYS = Object.freeze({
  fiscalYear: [
    'entityId', 'summaryYear', 'startDate', 'endDate', 'periodicity', 'timezone', 'periods'
  ],
  agent: ['teamId'],
  portfolio: ['functionId'],
  dossier: ['portfolioId'],
  project: ['dossierId'],
  phase: ['projectId']
});

class BudgetV2StoredRecordError extends Error {
  constructor() {
    super('Invalid stored Budget V2 record');
    this.name = 'BudgetV2StoredRecordError';
    this.code = 'BUDGET_STORAGE_UNAVAILABLE';
  }
}

const fail = () => { throw new BudgetV2StoredRecordError(); };

function hasExactFields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function isReferenceId(value) {
  return typeof value === 'string' && REFERENCE_ID_PATTERN.test(value)
    && Boolean(value.trim());
}

function isText(value, maximum, required = false) {
  return typeof value === 'string' && Array.from(value).length <= maximum
    && (!required || Boolean(value.trim()));
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(UTC_TIMESTAMP_PATTERN);
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
  if (!isUtcTimestamp(left) || !isUtcTimestamp(right)) fail();
  const leftMatch = left.match(UTC_TIMESTAMP_PATTERN);
  const rightMatch = right.match(UTC_TIMESTAMP_PATTERN);
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

function isIsoDate(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function isTimezone(value) {
  if (!isText(value, 64, true)) return false;
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
  const target = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return new Date(Date.UTC(
    target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)
  )).toISOString().slice(0, 10);
}

function dateInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateBudgetV2StoredRecordShape(record) {
  if (!hasExactFields(record, RECORD_KEYS)) fail();
  return record;
}

function validateSummary(record, requestAt) {
  if (!ID_PATTERN.test(record.id) || !isReferenceId(record.tenantId)
    || !isReferenceId(record.authorUserId) || !Number.isInteger(record.version)
    || record.version < 1 || record.version > MAX_VERSION
    || !isText(record.title, 120, true) || !isText(record.entity, 200, true)
    || typeof record.year !== 'string' || !/^\d{4}$/.test(record.year)
    || !isUtcTimestamp(record.createdAt) || !isUtcTimestamp(record.updatedAt)
    || compareUtcTimestamps(record.createdAt, record.updatedAt) > 0
    || compareUtcTimestamps(record.updatedAt, requestAt.toISOString()) > 0
    || record.scope !== 'organization' || record.status !== 'draft'
    || record.access !== 'owner-only') {
    fail();
  }
}

function validateFiscalYearSnapshot(snapshot) {
  if (!isReferenceId(snapshot.entityId) || !/^\d{4}$/.test(snapshot.summaryYear)
    || !isIsoDate(snapshot.startDate) || !isIsoDate(snapshot.endDate)
    || snapshot.startDate > snapshot.endDate || snapshot.periodicity !== 'monthly'
    || !isTimezone(snapshot.timezone) || !Array.isArray(snapshot.periods)
    || snapshot.periods.length !== 12) {
    fail();
  }
  let previousEnd = null;
  const ids = new Set();
  for (let index = 0; index < snapshot.periods.length; index += 1) {
    const period = snapshot.periods[index];
    if (!hasExactFields(period, PERIOD_KEYS) || !isReferenceId(period.periodId)
      || ids.has(period.periodId) || period.ordinal !== index + 1
      || !isIsoDate(period.startDate) || !isIsoDate(period.endDate)
      || period.startDate > period.endDate
      || (previousEnd !== null && period.startDate !== addUtcDay(previousEnd))) {
      fail();
    }
    const nextMonth = addUtcMonth(period.startDate);
    const expectedEnd = new Date(`${nextMonth}T00:00:00Z`);
    expectedEnd.setUTCDate(expectedEnd.getUTCDate() - 1);
    if (period.endDate !== expectedEnd.toISOString().slice(0, 10)) fail();
    ids.add(period.periodId);
    previousEnd = period.endDate;
  }
  if (snapshot.periods[0].startDate !== snapshot.startDate
    || snapshot.periods[11].endDate !== snapshot.endDate) fail();
}

function validateHistoricalStatus(snapshot, type) {
  let accepted;
  if (type === 'entity') accepted = snapshot.statusSnapshot === 'active';
  else if (type === 'fiscalYear') {
    accepted = ['planned', 'open'].includes(snapshot.statusSnapshot);
  } else if (type === 'project' || type === 'phase') {
    accepted = ['planned', 'active', 'open'].includes(snapshot.statusSnapshot);
  } else accepted = snapshot.statusSnapshot === 'active';
  if (!accepted) fail();
}

function validateSnapshot(snapshot, type) {
  const keys = [...BASE_SNAPSHOT_KEYS, ...(SNAPSHOT_EXTRA_KEYS[type] || [])];
  if (!hasExactFields(snapshot, keys) || !isReferenceId(snapshot.id)
    || !isText(snapshot.labelSnapshot, 200, true)
    || !isReferenceId(snapshot.statusSnapshot)
    || !isUtcTimestamp(snapshot.effectiveFrom)
    || (snapshot.effectiveTo !== null && !isUtcTimestamp(snapshot.effectiveTo))
    || !isReferenceId(snapshot.sourceRevision) || !isUtcTimestamp(snapshot.resolvedAt)
    || compareUtcTimestamps(snapshot.effectiveFrom, snapshot.resolvedAt) > 0
    || (snapshot.effectiveTo !== null
      && compareUtcTimestamps(snapshot.effectiveTo, snapshot.resolvedAt) <= 0)) {
    fail();
  }
  validateHistoricalStatus(snapshot, type);
  if (type === 'fiscalYear') validateFiscalYearSnapshot(snapshot);
  for (const key of SNAPSHOT_EXTRA_KEYS[type] || []) {
    if (key === 'periods'
      || ['summaryYear', 'startDate', 'endDate', 'periodicity', 'timezone'].includes(key)) {
      continue;
    }
    if (!isReferenceId(snapshot[key])) fail();
  }
}

function validateFiscalWriteInstant(snapshot) {
  const localDate = dateInTimezone(new Date(snapshot.resolvedAt), snapshot.timezone);
  const valid = (snapshot.statusSnapshot === 'planned' && localDate < snapshot.startDate)
    || (snapshot.statusSnapshot === 'open'
      && localDate >= snapshot.startDate && localDate <= snapshot.endDate);
  if (!valid) fail();
}

function validateDocument(record, requestAt) {
  const document = record.document;
  if (!hasExactFields(document, ROOT_KEYS) || document.contractVersion !== 2) fail();
  try {
    validateBudgetV2(document.budget);
  } catch (_error) {
    fail();
  }
  const snapshots = document.referenceSnapshots;
  if (!hasExactFields(snapshots, SNAPSHOT_ROOT_KEYS)
    || !hasExactFields(snapshots.identity, IDENTITY_KEYS)
    || !hasExactFields(snapshots.responsibilities, RESPONSIBILITY_KEYS)
    || !Array.isArray(snapshots.rows)
    || snapshots.rows.length !== document.budget.rows.length) {
    fail();
  }

  const seen = new Map();
  const resolvedTimes = new Set();
  const register = (snapshot, type, expectedId) => {
    if (snapshot === null || expectedId === null || snapshot?.id !== expectedId) fail();
    validateSnapshot(snapshot, type);
    resolvedTimes.add(snapshot.resolvedAt);
    const key = `${type}\u0000${snapshot.id}`;
    const canonical = canonicalJson(snapshot);
    if (seen.has(key) && seen.get(key) !== canonical) fail();
    seen.set(key, canonical);
    return snapshot;
  };

  const entity = register(
    snapshots.identity.entityId, 'entity', document.budget.identity.entityId
  );
  const fiscalYear = register(
    snapshots.identity.fiscalYearId, 'fiscalYear', document.budget.identity.fiscalYearId
  );
  register(
    snapshots.responsibilities.budgetOwnerAgentId,
    'agent', document.budget.responsibilities.budgetOwnerAgentId
  );
  if (document.budget.responsibilities.controllerAgentId === null) {
    if (snapshots.responsibilities.controllerAgentId !== null) fail();
  } else {
    register(
      snapshots.responsibilities.controllerAgentId,
      'agent', document.budget.responsibilities.controllerAgentId
    );
  }

  if (fiscalYear.entityId !== entity.id) fail();
  validateFiscalWriteInstant(fiscalYear);
  const expectedPeriods = fiscalYear.periods.map(period => period.periodId);

  for (let index = 0; index < document.budget.rows.length; index += 1) {
    const row = document.budget.rows[index];
    const storedRow = snapshots.rows[index];
    if (!hasExactFields(storedRow, SNAPSHOT_ROW_KEYS) || storedRow.rowId !== row.id
      || !hasExactFields(storedRow.dimensions, DIMENSION_KEYS)) fail();
    const actualPeriods = new Set(row.periodValues.map(period => period.periodId));
    if (actualPeriods.size !== expectedPeriods.length
      || expectedPeriods.some(periodId => !actualPeriods.has(periodId))) fail();
    const dimensions = {};
    for (const [field, type] of Object.entries(DIMENSION_TYPES)) {
      const expectedId = row.dimensions[field];
      const snapshot = storedRow.dimensions[field];
      if (expectedId === null) {
        if (snapshot !== null) fail();
        dimensions[field] = null;
      } else {
        dimensions[field] = register(snapshot, type, expectedId);
      }
    }
    if (dimensions.agentId && dimensions.teamId
      && dimensions.agentId.teamId !== dimensions.teamId.id) fail();
    if (dimensions.portfolioId
      && (!dimensions.functionId
        || dimensions.portfolioId.functionId !== dimensions.functionId.id)) fail();
    if (dimensions.dossierId
      && (!dimensions.portfolioId
        || dimensions.dossierId.portfolioId !== dimensions.portfolioId.id)) fail();
    if (dimensions.projectId
      && (!dimensions.dossierId
        || dimensions.projectId.dossierId !== dimensions.dossierId.id)) fail();
    if (dimensions.phaseId
      && (!dimensions.projectId
        || dimensions.phaseId.projectId !== dimensions.projectId.id)) fail();
  }

  if (resolvedTimes.size !== 1) fail();
  const [resolvedAt] = resolvedTimes;
  if (compareUtcTimestamps(resolvedAt, requestAt.toISOString()) > 0
    || record.updatedAt !== resolvedAt
    || (record.version === 1 && record.createdAt !== resolvedAt)
    || (record.version > 1 && compareUtcTimestamps(record.createdAt, resolvedAt) > 0)) fail();
  if (record.title !== document.budget.title
    || record.entity !== entity.labelSnapshot
    || record.year !== fiscalYear.summaryYear) fail();
  return document;
}

function validateBudgetV2StoredRecord(record, requestAt) {
  if (!(requestAt instanceof Date) || !Number.isFinite(requestAt.getTime())) fail();
  validateBudgetV2StoredRecordShape(record);
  validateSummary(record, requestAt);
  return validateDocument(record, requestAt);
}

module.exports = {
  BudgetV2StoredRecordError,
  ID_PATTERN,
  compareUtcTimestamps,
  isUtcTimestamp,
  validateBudgetV2StoredRecord,
  validateBudgetV2StoredRecordShape
};

const { MAX_VERSION, validateBudgetV2 } = require('./financeBudgetV2Contracts');
const { DIMENSION_TYPES, OPERATIONS } = require('./financeBudgetV2References');

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const MAX_LIST_OFFSET = 10000;
const MAX_LIST_CANDIDATES = 10051;
const MAX_LIST_POSITIONS = MAX_LIST_CANDIDATES + 1;
const MAX_LIST_SCAN_BYTES = 67108864;
const LIST_BATCH_SIZE = 50;

const RECORD_KEYS = Object.freeze([
  'id', 'tenantId', 'authorUserId', 'version', 'title', 'entity', 'year',
  'createdAt', 'updatedAt', 'scope', 'status', 'access', 'document'
]);
const SUMMARY_KEYS = Object.freeze([
  'id', 'version', 'title', 'entity', 'year', 'createdAt', 'updatedAt',
  'scope', 'status', 'access'
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
const OMIT_FROM_LIST = new Set([
  'BUDGET_REFERENCE_NOT_FOUND',
  'BUDGET_REFERENCE_STATE_INVALID',
  'BUDGET_FISCAL_YEAR_INVALID',
  'BUDGET_RESPONSIBILITY_INVALID',
  'BUDGET_REFERENCE_RELATION_INVALID'
]);
const REFERENCE_ERROR_CODES = new Set([
  'BUDGET_STORAGE_UNAVAILABLE',
  'BUDGET_REFERENCE_UNAVAILABLE',
  'BUDGET_REFERENCE_NOT_FOUND',
  'BUDGET_REFERENCE_STATE_INVALID',
  'BUDGET_FISCAL_YEAR_INVALID',
  'BUDGET_RESPONSIBILITY_INVALID',
  'BUDGET_REFERENCE_RELATION_INVALID'
]);

const SNAPSHOT_EXTRA_KEYS = Object.freeze({
  fiscalYear: ['entityId', 'summaryYear', 'startDate', 'endDate', 'periodicity', 'timezone', 'periods'],
  agent: ['teamId'],
  portfolio: ['functionId'],
  dossier: ['portfolioId'],
  project: ['dossierId'],
  phase: ['projectId']
});

class BudgetV2ReadError extends Error {
  constructor(code) {
    super('Budget V2 read failed');
    this.name = 'BudgetV2ReadError';
    this.code = code;
  }
}

const fail = code => { throw new BudgetV2ReadError(code); };

function hasExactFields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function hasOnlyFields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
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
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
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

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_error) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
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

function validateInput(input, list) {
  const required = list
    ? ['tenantId', 'actorId', 'v2Enabled', 'financeRead']
    : ['id', 'tenantId', 'actorId', 'v2Enabled', 'financeRead'];
  const optional = list ? ['limit', 'offset'] : [];
  if (!hasOnlyFields(input, required, optional)) fail('BUDGET_REQUEST_INVALID');
  if (!list && (typeof input.id !== 'string' || !ID_PATTERN.test(input.id))) {
    fail('BUDGET_REQUEST_INVALID');
  }
  if (list) {
    const limit = input.limit === undefined ? DEFAULT_LIST_LIMIT : input.limit;
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT
      || !Number.isInteger(offset) || offset < 0 || offset > MAX_LIST_OFFSET) {
      fail('BUDGET_REQUEST_INVALID');
    }
  }
  if (!isReferenceId(input.tenantId) || !isReferenceId(input.actorId)) {
    fail('BUDGET_AUTH_REQUIRED');
  }
  if (input.v2Enabled !== true) fail('BUDGET_V2_DISABLED');
  if (input.financeRead !== true) fail('BUDGET_ACCESS_DENIED');
}

function captureRequestAt(clock) {
  let value;
  try {
    value = clock();
  } catch (_error) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  return new Date(value.getTime());
}

function validateResolverResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.available !== true || !Array.isArray(result.records)) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
}

function validateRecordShape(record) {
  if (!hasExactFields(record, RECORD_KEYS)) fail('BUDGET_STORAGE_UNAVAILABLE');
}

function recordIsInScope(record, input) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !Object.hasOwn(record, 'tenantId') || !Object.hasOwn(record, 'authorUserId')) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  if (record.tenantId !== input.tenantId || record.authorUserId !== input.actorId) {
    return false;
  }
  if (!Object.hasOwn(record, 'id')) fail('BUDGET_STORAGE_UNAVAILABLE');
  return true;
}

function validateSummary(record, requestAt) {
  if (!ID_PATTERN.test(record.id) || !Number.isInteger(record.version)
    || record.version < 1 || record.version > MAX_VERSION
    || !isText(record.title, 120, true) || !isText(record.entity, 200, true)
    || typeof record.year !== 'string' || !/^\d{4}$/.test(record.year)
    || !isUtcTimestamp(record.createdAt) || !isUtcTimestamp(record.updatedAt)
    || compareUtcTimestamps(record.createdAt, record.updatedAt) > 0
    || compareUtcTimestamps(record.updatedAt, requestAt.toISOString()) > 0
    || record.scope !== 'organization' || record.status !== 'draft'
    || record.access !== 'owner-only') {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
}

function validateFiscalYearSnapshot(snapshot) {
  if (!isReferenceId(snapshot.entityId) || !/^\d{4}$/.test(snapshot.summaryYear)
    || !isIsoDate(snapshot.startDate) || !isIsoDate(snapshot.endDate)
    || snapshot.startDate > snapshot.endDate || snapshot.periodicity !== 'monthly'
    || !isTimezone(snapshot.timezone) || !Array.isArray(snapshot.periods)
    || snapshot.periods.length !== 12) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
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
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    const nextMonth = addUtcMonth(period.startDate);
    const expectedEnd = new Date(`${nextMonth}T00:00:00Z`);
    expectedEnd.setUTCDate(expectedEnd.getUTCDate() - 1);
    if (period.endDate !== expectedEnd.toISOString().slice(0, 10)) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    ids.add(period.periodId);
    previousEnd = period.endDate;
  }
  if (snapshot.periods[0].startDate !== snapshot.startDate
    || snapshot.periods[11].endDate !== snapshot.endDate) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
}

function validateHistoricalStatus(snapshot, type) {
  let accepted;
  if (type === 'entity') accepted = snapshot.statusSnapshot === 'active';
  else if (type === 'fiscalYear') {
    accepted = ['planned', 'open'].includes(snapshot.statusSnapshot);
  } else if (type === 'project' || type === 'phase') {
    accepted = ['planned', 'active', 'open'].includes(snapshot.statusSnapshot);
  } else accepted = snapshot.statusSnapshot === 'active';
  if (!accepted) fail('BUDGET_STORAGE_UNAVAILABLE');
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
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  validateHistoricalStatus(snapshot, type);
  if (type === 'fiscalYear') validateFiscalYearSnapshot(snapshot);
  for (const key of SNAPSHOT_EXTRA_KEYS[type] || []) {
    if (key === 'periods' || ['summaryYear', 'startDate', 'endDate', 'periodicity', 'timezone'].includes(key)) {
      continue;
    }
    if (!isReferenceId(snapshot[key])) fail('BUDGET_STORAGE_UNAVAILABLE');
  }
}

function validateFiscalWriteInstant(snapshot) {
  const localDate = dateInTimezone(new Date(snapshot.resolvedAt), snapshot.timezone);
  const valid = (snapshot.statusSnapshot === 'planned' && localDate < snapshot.startDate)
    || (snapshot.statusSnapshot === 'open'
      && localDate >= snapshot.startDate && localDate <= snapshot.endDate);
  if (!valid) fail('BUDGET_STORAGE_UNAVAILABLE');
}

function validateStoredDocument(record, requestAt) {
  const document = record.document;
  if (!hasExactFields(document, ROOT_KEYS) || document.contractVersion !== 2) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  try {
    validateBudgetV2(document.budget);
  } catch (_error) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  const snapshots = document.referenceSnapshots;
  if (!hasExactFields(snapshots, SNAPSHOT_ROOT_KEYS)
    || !hasExactFields(snapshots.identity, IDENTITY_KEYS)
    || !hasExactFields(snapshots.responsibilities, RESPONSIBILITY_KEYS)
    || !Array.isArray(snapshots.rows)
    || snapshots.rows.length !== document.budget.rows.length) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }

  const seen = new Map();
  const resolvedTimes = new Set();
  const register = (snapshot, type, expectedId) => {
    if (snapshot === null || expectedId === null || snapshot?.id !== expectedId) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    validateSnapshot(snapshot, type);
    resolvedTimes.add(snapshot.resolvedAt);
    const key = `${type}\u0000${snapshot.id}`;
    const canonical = canonicalJson(snapshot);
    if (seen.has(key) && seen.get(key) !== canonical) fail('BUDGET_STORAGE_UNAVAILABLE');
    seen.set(key, canonical);
    return snapshot;
  };

  const entity = register(
    snapshots.identity.entityId, 'entity', document.budget.identity.entityId
  );
  const fiscalYear = register(
    snapshots.identity.fiscalYearId, 'fiscalYear', document.budget.identity.fiscalYearId
  );
  const owner = register(
    snapshots.responsibilities.budgetOwnerAgentId,
    'agent', document.budget.responsibilities.budgetOwnerAgentId
  );
  let controller = null;
  if (document.budget.responsibilities.controllerAgentId === null) {
    if (snapshots.responsibilities.controllerAgentId !== null) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
  } else {
    controller = register(
      snapshots.responsibilities.controllerAgentId,
      'agent', document.budget.responsibilities.controllerAgentId
    );
  }

  if (fiscalYear.entityId !== entity.id) fail('BUDGET_STORAGE_UNAVAILABLE');
  validateFiscalWriteInstant(fiscalYear);
  const expectedPeriods = fiscalYear.periods.map(period => period.periodId);

  for (let index = 0; index < document.budget.rows.length; index += 1) {
    const row = document.budget.rows[index];
    const storedRow = snapshots.rows[index];
    if (!hasExactFields(storedRow, SNAPSHOT_ROW_KEYS) || storedRow.rowId !== row.id
      || !hasExactFields(storedRow.dimensions, DIMENSION_KEYS)) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    const actualPeriods = new Set(row.periodValues.map(period => period.periodId));
    if (actualPeriods.size !== expectedPeriods.length
      || expectedPeriods.some(periodId => !actualPeriods.has(periodId))) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    const dimensions = {};
    for (const [field, type] of Object.entries(DIMENSION_TYPES)) {
      const expectedId = row.dimensions[field];
      const snapshot = storedRow.dimensions[field];
      if (expectedId === null) {
        if (snapshot !== null) fail('BUDGET_STORAGE_UNAVAILABLE');
        dimensions[field] = null;
      } else {
        dimensions[field] = register(snapshot, type, expectedId);
      }
    }
    if (dimensions.agentId && dimensions.teamId
      && dimensions.agentId.teamId !== dimensions.teamId.id) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (dimensions.portfolioId
      && (!dimensions.functionId
        || dimensions.portfolioId.functionId !== dimensions.functionId.id)) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (dimensions.dossierId
      && (!dimensions.portfolioId
        || dimensions.dossierId.portfolioId !== dimensions.portfolioId.id)) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (dimensions.projectId
      && (!dimensions.dossierId
        || dimensions.projectId.dossierId !== dimensions.dossierId.id)) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (dimensions.phaseId
      && (!dimensions.projectId
        || dimensions.phaseId.projectId !== dimensions.projectId.id)) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
  }

  if (resolvedTimes.size !== 1) fail('BUDGET_STORAGE_UNAVAILABLE');
  const [resolvedAt] = resolvedTimes;
  if (compareUtcTimestamps(resolvedAt, requestAt.toISOString()) > 0
    || record.updatedAt !== resolvedAt
    || (record.version === 1 && record.createdAt !== resolvedAt)
    || (record.version > 1 && compareUtcTimestamps(record.createdAt, resolvedAt) > 0)) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  if (record.title !== document.budget.title
    || record.entity !== entity.labelSnapshot
    || record.year !== fiscalYear.summaryYear) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  void owner;
  void controller;
  return document;
}

function isV2Record(record) {
  return record?.document?.contractVersion === 2;
}

function summary(record) {
  return Object.fromEntries(SUMMARY_KEYS.map(key => [key, record[key]]));
}

function compareCandidateOrder(previous, current) {
  if (previous === null) return true;
  const timeOrder = compareUtcTimestamps(previous.updatedAt, current.updatedAt);
  if (timeOrder !== 0) return timeOrder > 0;
  return previous.id < current.id;
}

function createBudgetV2ReadService({ storage, referenceServiceFactory, clock } = {}) {
  const now = typeof clock === 'function' ? clock : () => new Date();

  function newReferenceService(context) {
    if (typeof referenceServiceFactory !== 'function') fail('BUDGET_REFERENCE_UNAVAILABLE');
    let service;
    try {
      service = referenceServiceFactory(context);
    } catch (_error) {
      fail('BUDGET_REFERENCE_UNAVAILABLE');
    }
    if (!service || typeof service.resolveStoredBudgetReferences !== 'function') {
      fail('BUDGET_REFERENCE_UNAVAILABLE');
    }
    return service;
  }

  function lazyReferenceService(context) {
    let service = null;
    return () => {
      if (service === null) service = newReferenceService(context);
      return service;
    };
  }

  async function resolveCurrentReferences(service, record, input, requestAt) {
    try {
      await service.resolveStoredBudgetReferences({
        rawBudget: record.document.budget,
        tenantId: input.tenantId,
        actorId: input.actorId,
        operation: OPERATIONS.READ,
        resolvedAt: new Date(requestAt.getTime())
      });
    } catch (error) {
      if (REFERENCE_ERROR_CODES.has(error?.code)) fail(error.code);
      fail('BUDGET_REFERENCE_UNAVAILABLE');
    }
  }

  async function assertNoPromotionLink(record, input) {
    if (Object.hasOwn(record.document, 'promotion')) fail('BUDGET_STORAGE_UNAVAILABLE');
    if (!storage || typeof storage.findPromotionLinks !== 'function') {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    let result;
    try {
      result = await storage.findPromotionLinks({
        tenantId: input.tenantId,
        authorUserId: input.actorId,
        draftId: record.id
      });
    } catch (_error) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    validateResolverResult(result);
    if (result.records.length !== 0) fail('BUDGET_STORAGE_UNAVAILABLE');
  }

  async function inspectRecord(record, input, requestAt, getReferenceService,
    expectedId, expectedUpdatedAt = null) {
    if (!recordIsInScope(record, input)) fail('BUDGET_DRAFT_NOT_FOUND');
    if (record.id !== expectedId || !Object.hasOwn(record, 'document')
      || !record.document || typeof record.document !== 'object'
      || Array.isArray(record.document)) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (!isV2Record(record)) fail('BUDGET_DRAFT_NOT_FOUND');
    await resolveCurrentReferences(getReferenceService(), record, input, requestAt);
    validateRecordShape(record);
    if (expectedUpdatedAt !== null && record.updatedAt !== expectedUpdatedAt) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    await assertNoPromotionLink(record, input);
    validateSummary(record, requestAt);
    return validateStoredDocument(record, requestAt);
  }

  async function readDraft(input) {
    validateInput(input, false);
    const requestAt = captureRequestAt(now);
    if (!storage || typeof storage.getCurrentDraft !== 'function') {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    let result;
    try {
      result = await storage.getCurrentDraft({
        id: input.id,
        tenantId: input.tenantId,
        authorUserId: input.actorId
      });
    } catch (_error) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    validateResolverResult(result);
    if (result.records.length === 0) fail('BUDGET_DRAFT_NOT_FOUND');
    if (result.records.length !== 1) fail('BUDGET_STORAGE_UNAVAILABLE');
    const record = result.records[0];
    const getReferenceService = lazyReferenceService({
      tenantId: input.tenantId, actorId: input.actorId, requestAt: new Date(requestAt)
    });
    const document = await inspectRecord(record, input, requestAt, getReferenceService, input.id);
    return {
      success: true,
      contractVersion: 2,
      data: { ...summary(record), budget: clone(document.budget),
        referenceSnapshots: clone(document.referenceSnapshots) }
    };
  }

  async function listDrafts(input) {
    validateInput(input, true);
    const limit = input.limit === undefined ? DEFAULT_LIST_LIMIT : input.limit;
    const offset = input.offset === undefined ? 0 : input.offset;
    const target = offset + limit + 1;
    const requestAt = captureRequestAt(now);
    if (!storage || typeof storage.scanCurrentDrafts !== 'function') {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    let batches;
    try {
      batches = storage.scanCurrentDrafts({
        tenantId: input.tenantId,
        authorUserId: input.actorId,
        batchSize: LIST_BATCH_SIZE,
        maxPositions: MAX_LIST_POSITIONS
      });
    } catch (_error) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (!batches || typeof batches[Symbol.asyncIterator] !== 'function') {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }

    const getReferenceService = lazyReferenceService({
      tenantId: input.tenantId, actorId: input.actorId, requestAt: new Date(requestAt)
    });
    const readable = [];
    const ids = new Set();
    let positions = 0;
    let scanBytes = 0;
    let previous = null;
    let sentinelSeen = false;

    try {
      for await (const batch of batches) {
        if (!Array.isArray(batch) || batch.length < 1 || batch.length > LIST_BATCH_SIZE) {
          fail('BUDGET_STORAGE_UNAVAILABLE');
        }
        for (const handle of batch) {
          positions += 1;
          if (positions === MAX_LIST_POSITIONS) {
            sentinelSeen = true;
            break;
          }
          if (positions > MAX_LIST_POSITIONS || !handle
            || typeof handle !== 'object' || Array.isArray(handle)
            || !Number.isInteger(handle.serializedBytes) || handle.serializedBytes < 1
            || typeof handle.load !== 'function') {
            fail('BUDGET_STORAGE_UNAVAILABLE');
          }
          if (scanBytes + handle.serializedBytes > MAX_LIST_SCAN_BYTES) {
            fail('BUDGET_STORAGE_UNAVAILABLE');
          }
          let record;
          try {
            record = await handle.load();
          } catch (_error) {
            fail('BUDGET_STORAGE_UNAVAILABLE');
          }
          scanBytes += handle.serializedBytes;
          if (!recordIsInScope(record, input)) continue;
          if (!hasExactFields(handle, ['id', 'updatedAt', 'serializedBytes', 'load'])
            || !ID_PATTERN.test(handle.id) || !isUtcTimestamp(handle.updatedAt)
            || !compareCandidateOrder(previous, handle) || ids.has(handle.id)
            || serializedBytes(record.document) !== handle.serializedBytes) {
            fail('BUDGET_STORAGE_UNAVAILABLE');
          }
          previous = { id: handle.id, updatedAt: handle.updatedAt };
          ids.add(handle.id);
          try {
            await inspectRecord(
              record, input, requestAt, getReferenceService, handle.id, handle.updatedAt
            );
            readable.push(summary(record));
          } catch (error) {
            if (!OMIT_FROM_LIST.has(error?.code)
              && error?.code !== 'BUDGET_DRAFT_NOT_FOUND') throw error;
          }
          if (readable.length >= target) {
            return {
              success: true,
              contractVersion: 2,
              data: clone(readable.slice(offset, offset + limit)),
              hasMore: readable.length > offset + limit
            };
          }
        }
        if (sentinelSeen) break;
      }
    } catch (error) {
      if (error instanceof BudgetV2ReadError) throw error;
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (sentinelSeen) fail('BUDGET_STORAGE_UNAVAILABLE');
    return {
      success: true,
      contractVersion: 2,
      data: clone(readable.slice(offset, offset + limit)),
      hasMore: false
    };
  }

  return Object.freeze({ readDraft, listDrafts });
}

module.exports = {
  BudgetV2ReadError,
  DEFAULT_LIST_LIMIT,
  ID_PATTERN,
  LIST_BATCH_SIZE,
  MAX_LIST_CANDIDATES,
  MAX_LIST_LIMIT,
  MAX_LIST_OFFSET,
  MAX_LIST_POSITIONS,
  MAX_LIST_SCAN_BYTES,
  createBudgetV2ReadService
};

const { OPERATIONS } = require('./financeBudgetV2References');
const {
  ID_PATTERN,
  compareUtcTimestamps,
  isUtcTimestamp,
  validateBudgetV2StoredRecord,
  validateBudgetV2StoredRecordShape
} = require('./financeBudgetV2StoredRecords');

const REFERENCE_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const MAX_LIST_OFFSET = 10000;
const MAX_LIST_CANDIDATES = 10051;
const MAX_LIST_POSITIONS = MAX_LIST_CANDIDATES + 1;
const MAX_LIST_SCAN_BYTES = 67108864;
const LIST_BATCH_SIZE = 50;

const SUMMARY_KEYS = Object.freeze([
  'id', 'version', 'title', 'entity', 'year', 'createdAt', 'updatedAt',
  'scope', 'status', 'access'
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

function validateResolverResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.available !== true || !Array.isArray(result.records)) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
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
    try {
      validateBudgetV2StoredRecordShape(record);
    } catch (_error) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (expectedUpdatedAt !== null && record.updatedAt !== expectedUpdatedAt) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    await assertNoPromotionLink(record, input);
    try {
      return validateBudgetV2StoredRecord(record, requestAt);
    } catch (_error) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
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

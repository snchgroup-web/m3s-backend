const {
  ID_PATTERN,
  compareUtcTimestamps,
  isUtcTimestamp,
  validateBudgetV2StoredRecord
} = require('./financeBudgetV2StoredRecords');

const MAX_STORED_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BATCH_SIZE = 50;
const MAX_SCAN_POSITIONS = 10052;
const REFERENCE_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;

const TARGET = Object.freeze({
  contractVersion: 2,
  currentStore: 'finance_budget_drafts_v2_current',
  eventStore: 'finance_budget_draft_events_v2',
  promotionEnabled: false
});

const TARGET_KEYS = Object.freeze(Object.keys(TARGET));
const ROW_KEYS = Object.freeze([
  'id', 'tenant_id', 'author_user_id', 'contract_version', 'version', 'title',
  'entity', 'year', 'scope', 'status', 'access', 'document_json', 'document_bytes',
  'created_at', 'updated_at'
]);
const META_KEYS = Object.freeze(['id', 'updated_at', 'document_bytes']);
const AUDIT_KEYS = Object.freeze(['action', 'draftId', 'version', 'occurredAt']);
const PROBE_CONTRACT_KEYS = Object.freeze([
  ...TARGET_KEYS, 'effectiveUniqueness', 'atomicCreate', 'atomicReplace'
]);
const WRITE_OUTCOMES = new Set([
  'created', 'updated', 'missing', 'conflict', 'duplicate', 'unavailable', 'uncertain'
]);

class BudgetV2StorageAdapterError extends Error {
  constructor() {
    super('Budget V2 storage adapter failed');
    this.name = 'BudgetV2StorageAdapterError';
    this.code = 'BUDGET_STORAGE_UNAVAILABLE';
  }
}

const fail = () => { throw new BudgetV2StorageAdapterError(); };

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function referenceId(value) {
  return typeof value === 'string' && REFERENCE_ID_PATTERN.test(value)
    && Boolean(value.trim());
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    fail();
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function plan(operation, payload = {}) {
  return deepFreeze({ operation, target: { ...TARGET }, ...clone(payload) });
}

function assertQuery(query, keys, { uuid = false } = {}) {
  if (!exact(query, keys) || !referenceId(query.tenantId)
    || !referenceId(query.authorUserId)
    || (uuid && (typeof query.id !== 'string' || !ID_PATTERN.test(query.id)))) fail();
}

function assertExecutor(executor, method) {
  if (!executor || typeof executor[method] !== 'function') fail();
}

async function execute(executor, method, request) {
  assertExecutor(executor, method);
  try {
    return await executor[method](request);
  } catch (_error) {
    fail();
  }
}

function serializedDocument(document) {
  let json;
  try {
    json = JSON.stringify(document);
  } catch (_error) {
    fail();
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes < 1 || bytes > MAX_STORED_DOCUMENT_BYTES) fail();
  return { json, bytes };
}

function recordToRow(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !isUtcTimestamp(record.updatedAt)) fail();
  try {
    validateBudgetV2StoredRecord(record, new Date(record.updatedAt));
  } catch (_error) {
    fail();
  }
  const document = serializedDocument(record.document);
  return {
    id: record.id,
    tenant_id: record.tenantId,
    author_user_id: record.authorUserId,
    contract_version: 2,
    version: record.version,
    title: record.title,
    entity: record.entity,
    year: record.year,
    scope: record.scope,
    status: record.status,
    access: record.access,
    document_json: document.json,
    document_bytes: document.bytes,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function rowToRecord(row) {
  if (!exact(row, ROW_KEYS) || row.contract_version !== 2
    || !Number.isSafeInteger(row.document_bytes) || row.document_bytes < 1
    || row.document_bytes > MAX_STORED_DOCUMENT_BYTES
    || typeof row.document_json !== 'string'
    || Buffer.byteLength(row.document_json, 'utf8') !== row.document_bytes) fail();
  let document;
  try {
    document = JSON.parse(row.document_json);
  } catch (_error) {
    fail();
  }
  const record = {
    id: row.id,
    tenantId: row.tenant_id,
    authorUserId: row.author_user_id,
    version: row.version,
    title: row.title,
    entity: row.entity,
    year: row.year,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scope: row.scope,
    status: row.status,
    access: row.access,
    document
  };
  if (!isUtcTimestamp(record.updatedAt)) fail();
  try {
    validateBudgetV2StoredRecord(record, new Date(record.updatedAt));
  } catch (_error) {
    fail();
  }
  return record;
}

function assertRowsResult(result, maximum) {
  if (!exact(result, ['available', 'rows']) || result.available !== true
    || !Array.isArray(result.rows) || result.rows.length > maximum) fail();
  return result.rows;
}

function metadata(row) {
  if (!exact(row, META_KEYS) || typeof row.id !== 'string' || !ID_PATTERN.test(row.id)
    || !isUtcTimestamp(row.updated_at) || !Number.isSafeInteger(row.document_bytes)
    || row.document_bytes < 1 || row.document_bytes > MAX_STORED_DOCUMENT_BYTES) fail();
  return { id: row.id, updatedAt: row.updated_at, serializedBytes: row.document_bytes };
}

function compareMetadata(left, right) {
  const compared = compareUtcTimestamps(left.updatedAt, right.updatedAt);
  return compared > 0 || (compared === 0 && left.id < right.id);
}

function assertAudit(audit, record, action) {
  if (!exact(audit, AUDIT_KEYS) || audit.action !== action
    || audit.draftId !== record.id || audit.version !== record.version
    || audit.occurredAt !== record.updatedAt) fail();
  return {
    action: audit.action,
    draft_id: audit.draftId,
    tenant_id: record.tenantId,
    actor_user_id: record.authorUserId,
    version: audit.version,
    occurred_at: audit.occurredAt
  };
}

function validateWriteOutcome(result, success, id, version) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !WRITE_OUTCOMES.has(result.outcome)) fail();
  if (result.outcome === success) {
    if (!exact(result, ['outcome', 'id', 'version'])
      || result.id !== id || result.version !== version) fail();
    return clone(result);
  }
  if (!exact(result, ['outcome'])) fail();
  if (success === 'created' && ['updated', 'missing', 'conflict'].includes(result.outcome)) fail();
  if (success === 'updated' && result.outcome === 'created') fail();
  return { outcome: result.outcome };
}

function createBudgetV2StorageAdapter({ executor } = {}) {
  async function probe() {
    const result = await execute(executor, 'probe', plan('probe'));
    if (!exact(result, ['available', 'contract']) || result.available !== true
      || !exact(result.contract, PROBE_CONTRACT_KEYS)
      || TARGET_KEYS.some(key => result.contract[key] !== TARGET[key])
      || result.contract.effectiveUniqueness !== true
      || result.contract.atomicCreate !== true
      || result.contract.atomicReplace !== true) fail();
    return { available: true };
  }

  async function getCurrentDraft(query) {
    assertQuery(query, ['id', 'tenantId', 'authorUserId'], { uuid: true });
    const result = await execute(executor, 'getCurrent', plan('getCurrent', {
      where: {
        id: query.id,
        tenantId: query.tenantId,
        authorUserId: query.authorUserId,
        contractVersion: 2
      },
      limit: 2
    }));
    return { available: true, records: assertRowsResult(result, 2).map(rowToRecord) };
  }

  async function loadCurrent(query, expectedUpdatedAt) {
    const result = await execute(executor, 'loadCurrent', plan('loadCurrent', {
      where: {
        id: query.id,
        tenantId: query.tenantId,
        authorUserId: query.authorUserId,
        contractVersion: 2,
        updatedAt: expectedUpdatedAt
      },
      limit: 2
    }));
    const rows = assertRowsResult(result, 2);
    if (rows.length !== 1) fail();
    const record = rowToRecord(rows[0]);
    if (record.id !== query.id || record.tenantId !== query.tenantId
      || record.authorUserId !== query.authorUserId
      || record.updatedAt !== expectedUpdatedAt) fail();
    return clone(record);
  }

  function scanCurrentDrafts(query) {
    assertQuery(query, ['tenantId', 'authorUserId', 'batchSize', 'maxPositions']);
    if (!Number.isInteger(query.batchSize) || query.batchSize < 1
      || query.batchSize > MAX_SCAN_BATCH_SIZE
      || !Number.isInteger(query.maxPositions) || query.maxPositions < 1
      || query.maxPositions > MAX_SCAN_POSITIONS) fail();

    return (async function* scan() {
      let after = null;
      let previous = null;
      let positions = 0;
      const seenCursors = new Set();
      while (positions < query.maxPositions) {
        const limit = Math.min(query.batchSize, query.maxPositions - positions);
        const result = await execute(executor, 'scanCurrent', plan('scanCurrent', {
          where: {
            tenantId: query.tenantId,
            authorUserId: query.authorUserId,
            contractVersion: 2
          },
          order: ['updatedAt:desc', 'id:asc'],
          after,
          limit
        }));
        if (!exact(result, ['available', 'rows', 'nextCursor'])
          || result.available !== true || !Array.isArray(result.rows)
          || result.rows.length > limit) fail();
        const batch = result.rows.map(metadata);
        for (const item of batch) {
          if (previous && !compareMetadata(previous, item)) fail();
          previous = item;
        }
        if (result.nextCursor !== null) {
          if (!exact(result.nextCursor, ['updatedAt', 'id']) || batch.length === 0) fail();
          const last = batch.at(-1);
          if (result.nextCursor.updatedAt !== last.updatedAt || result.nextCursor.id !== last.id) fail();
          const cursorKey = `${last.updatedAt}\u0000${last.id}`;
          if (seenCursors.has(cursorKey)) fail();
          seenCursors.add(cursorKey);
        }
        if (batch.length > 0) {
          yield batch.map(item => ({
            id: item.id,
            updatedAt: item.updatedAt,
            serializedBytes: item.serializedBytes,
            load: () => loadCurrent({
              id: item.id,
              tenantId: query.tenantId,
              authorUserId: query.authorUserId
            }, item.updatedAt)
          }));
          positions += batch.length;
        }
        if (result.nextCursor === null) return;
        after = clone(result.nextCursor);
      }
    }());
  }

  async function findPromotionLinks(query) {
    assertQuery(query, ['tenantId', 'authorUserId', 'draftId']);
    if (typeof query.draftId !== 'string' || !ID_PATTERN.test(query.draftId)
      || TARGET.promotionEnabled !== false) fail();
    return { available: true, records: [] };
  }

  async function createCurrentDraft(input) {
    if (!exact(input, ['record', 'audit'])) fail();
    const row = recordToRow(input.record);
    const audit = assertAudit(input.audit, input.record, 'budget_v2_draft_created');
    if (input.record.version !== 1 || input.record.createdAt !== input.record.updatedAt) fail();
    const result = await execute(executor, 'createAtomic', plan('createAtomic', { row, audit }));
    return validateWriteOutcome(result, 'created', input.record.id, 1);
  }

  async function replaceCurrentDraft(input) {
    if (!exact(input, [
      'id', 'tenantId', 'authorUserId', 'expectedVersion', 'nextRecord', 'audit'
    ]) || typeof input.id !== 'string' || !ID_PATTERN.test(input.id)
      || !referenceId(input.tenantId) || !referenceId(input.authorUserId)
      || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1
      || input.nextRecord?.id !== input.id
      || input.nextRecord?.tenantId !== input.tenantId
      || input.nextRecord?.authorUserId !== input.authorUserId
      || input.nextRecord?.version !== input.expectedVersion + 1) fail();
    const row = recordToRow(input.nextRecord);
    const audit = assertAudit(input.audit, input.nextRecord, 'budget_v2_draft_updated');
    const result = await execute(executor, 'replaceAtomic', plan('replaceAtomic', {
      where: {
        id: input.id,
        tenantId: input.tenantId,
        authorUserId: input.authorUserId,
        contractVersion: 2,
        expectedVersion: input.expectedVersion
      },
      row,
      audit
    }));
    return validateWriteOutcome(
      result, 'updated', input.nextRecord.id, input.nextRecord.version
    );
  }

  return Object.freeze({
    probe,
    getCurrentDraft,
    scanCurrentDrafts,
    findPromotionLinks,
    createCurrentDraft,
    replaceCurrentDraft
  });
}

module.exports = {
  BudgetV2StorageAdapterError,
  MAX_SCAN_BATCH_SIZE,
  MAX_SCAN_POSITIONS,
  MAX_STORED_DOCUMENT_BYTES,
  TARGET,
  createBudgetV2StorageAdapter
};

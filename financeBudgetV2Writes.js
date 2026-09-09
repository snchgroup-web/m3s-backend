const {
  MAX_VERSION,
  validateBudgetV2CreateBody,
  validateBudgetV2UpdateBody
} = require('./financeBudgetV2Contracts');
const { OPERATIONS } = require('./financeBudgetV2References');
const {
  ID_PATTERN,
  validateBudgetV2StoredRecord
} = require('./financeBudgetV2StoredRecords');

const REFERENCE_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;
const SUMMARY_KEYS = Object.freeze([
  'id', 'version', 'title', 'entity', 'year', 'createdAt', 'updatedAt',
  'scope', 'status', 'access'
]);
const REFERENCE_ERROR_CODES = new Set([
  'BUDGET_REFERENCE_UNAVAILABLE',
  'BUDGET_REFERENCE_NOT_FOUND',
  'BUDGET_REFERENCE_STATE_INVALID',
  'BUDGET_FISCAL_YEAR_INVALID',
  'BUDGET_RESPONSIBILITY_INVALID',
  'BUDGET_REFERENCE_RELATION_INVALID'
]);

class BudgetV2WriteError extends Error {
  constructor(code, draftId) {
    super('Budget V2 write failed');
    this.name = 'BudgetV2WriteError';
    this.code = code;
    if (code === 'BUDGET_WRITE_UNCERTAIN') {
      this.draftId = draftId;
      this.reconcileRequired = true;
    }
  }
}

const fail = (code, draftId) => { throw new BudgetV2WriteError(code, draftId); };

function hasExactFields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
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

function summary(record) {
  return Object.fromEntries(SUMMARY_KEYS.map(key => [key, record[key]]));
}

function validateCommand(input, update) {
  const keys = update
    ? ['id', 'tenantId', 'actorId', 'v2Enabled', 'financeRead', 'financeWrite', 'body']
    : ['tenantId', 'actorId', 'v2Enabled', 'financeRead', 'financeWrite', 'body'];
  if (!hasExactFields(input, keys)) fail('BUDGET_REQUEST_INVALID');
  if (update && (typeof input.id !== 'string' || !ID_PATTERN.test(input.id))) {
    fail('BUDGET_REQUEST_INVALID');
  }
  let serializedBody;
  try {
    serializedBody = update
      ? validateBudgetV2UpdateBody(input.body)
      : validateBudgetV2CreateBody(input.body);
  } catch (_error) {
    fail('BUDGET_REQUEST_INVALID');
  }
  if (!isReferenceId(input.tenantId) || !isReferenceId(input.actorId)) {
    fail('BUDGET_AUTH_REQUIRED');
  }
  if (input.v2Enabled !== true) fail('BUDGET_V2_DISABLED');
  if (input.financeRead !== true || input.financeWrite !== true) {
    fail('BUDGET_ACCESS_DENIED');
  }
  let safeBody;
  try {
    safeBody = JSON.parse(serializedBody);
    if (update) validateBudgetV2UpdateBody(safeBody);
    else validateBudgetV2CreateBody(safeBody);
  } catch (_error) {
    fail('BUDGET_REQUEST_INVALID');
  }
  return safeBody;
}

async function assertStorageAvailable(storage) {
  if (!storage || typeof storage.probe !== 'function') {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  let result;
  try {
    result = await storage.probe();
  } catch (_error) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  if (!hasExactFields(result, ['available']) || result.available !== true) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
}

function captureWriteAt(clock) {
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

function generateDraftId(uuidGenerator) {
  let id;
  try {
    id = uuidGenerator();
  } catch (_error) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  return id;
}

function validateLookupResult(result) {
  if (!hasExactFields(result, ['available', 'records'])
    || result.available !== true || !Array.isArray(result.records)) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
}

function currentRecordInScope(record, input) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !Object.hasOwn(record, 'tenantId') || !Object.hasOwn(record, 'authorUserId')) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  if (record.tenantId !== input.tenantId || record.authorUserId !== input.actorId) {
    fail('BUDGET_DRAFT_NOT_FOUND');
  }
  if (!Object.hasOwn(record, 'id') || record.id !== input.id) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  if (record?.document?.contractVersion !== 2) fail('BUDGET_DRAFT_NOT_FOUND');
  return record;
}

async function assertNoPromotionLink(storage, input, draftId, record) {
  if (record && Object.hasOwn(record.document, 'promotion')) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  if (typeof storage.findPromotionLinks !== 'function') {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  let result;
  try {
    result = await storage.findPromotionLinks({
      tenantId: input.tenantId,
      authorUserId: input.actorId,
      draftId
    });
  } catch (_error) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  validateLookupResult(result);
  if (result.records.length !== 0) fail('BUDGET_STORAGE_UNAVAILABLE');
}

function createReferenceService(referenceServiceFactory, input, writeAt) {
  if (typeof referenceServiceFactory !== 'function') {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  let service;
  try {
    service = referenceServiceFactory({
      tenantId: input.tenantId,
      actorId: input.actorId,
      writeAt: new Date(writeAt.getTime())
    });
  } catch (_error) {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  if (!service || typeof service.resolveBudgetReferences !== 'function') {
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
  return service;
}

async function resolveReferences(referenceServiceFactory, input, writeAt) {
  const service = createReferenceService(referenceServiceFactory, input, writeAt);
  try {
    const snapshots = await service.resolveBudgetReferences({
      budget: clone(input.body.budget),
      tenantId: input.tenantId,
      actorId: input.actorId,
      operation: OPERATIONS.WRITE
    });
    return clone(snapshots);
  } catch (error) {
    if (REFERENCE_ERROR_CODES.has(error?.code)) fail(error.code);
    fail('BUDGET_REFERENCE_UNAVAILABLE');
  }
}

function buildRecord({ id, input, snapshots, version, createdAt, writeAt }) {
  const timestamp = writeAt.toISOString();
  const budget = clone(input.body.budget);
  const document = {
    contractVersion: 2,
    budget,
    referenceSnapshots: clone(snapshots)
  };
  const record = {
    id,
    tenantId: input.tenantId,
    authorUserId: input.actorId,
    version,
    title: budget.title,
    entity: document.referenceSnapshots?.identity?.entityId?.labelSnapshot,
    year: document.referenceSnapshots?.identity?.fiscalYearId?.summaryYear,
    createdAt,
    updatedAt: timestamp,
    scope: 'organization',
    status: 'draft',
    access: 'owner-only',
    document
  };
  try {
    validateBudgetV2StoredRecord(record, writeAt);
  } catch (_error) {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  return record;
}

function buildAudit(action, draftId, version, writeAt) {
  return {
    action,
    draftId,
    version,
    occurredAt: writeAt.toISOString()
  };
}

function validateWriteResult(result, successOutcome, id, version) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.outcome !== 'string') {
    fail('BUDGET_WRITE_UNCERTAIN', id);
  }
  if (result.outcome === successOutcome) {
    if (!hasExactFields(result, ['outcome', 'id', 'version'])
      || result.id !== id || result.version !== version) {
      fail('BUDGET_WRITE_UNCERTAIN', id);
    }
    return;
  }
  if (!hasExactFields(result, ['outcome'])) fail('BUDGET_WRITE_UNCERTAIN', id);
  if (result.outcome === 'missing') fail('BUDGET_DRAFT_NOT_FOUND');
  if (result.outcome === 'conflict') fail('BUDGET_VERSION_CONFLICT');
  if (result.outcome === 'uncertain') fail('BUDGET_WRITE_UNCERTAIN', id);
  if (result.outcome === 'duplicate' || result.outcome === 'unavailable') {
    fail('BUDGET_STORAGE_UNAVAILABLE');
  }
  fail('BUDGET_WRITE_UNCERTAIN', id);
}

function createBudgetV2WriteService({
  storage,
  referenceServiceFactory,
  clock,
  uuidGenerator
} = {}) {
  const now = typeof clock === 'function' ? clock : () => new Date(NaN);
  const newUuid = typeof uuidGenerator === 'function' ? uuidGenerator : () => null;

  async function createDraft(input) {
    const body = validateCommand(input, false);
    const command = { ...input, body };
    await assertStorageAvailable(storage);
    const writeAt = captureWriteAt(now);
    const id = generateDraftId(newUuid);
    const snapshots = await resolveReferences(referenceServiceFactory, command, writeAt);
    await assertNoPromotionLink(storage, command, id, null);
    const record = buildRecord({
      id,
      input: command,
      snapshots,
      version: 1,
      createdAt: writeAt.toISOString(),
      writeAt
    });
    if (typeof storage.createCurrentDraft !== 'function') {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    let result;
    try {
      result = await storage.createCurrentDraft({
        record: clone(record),
        audit: buildAudit('budget_v2_draft_created', id, 1, writeAt)
      });
    } catch (_error) {
      fail('BUDGET_WRITE_UNCERTAIN', id);
    }
    validateWriteResult(result, 'created', id, 1);
    return { success: true, contractVersion: 2, data: summary(record) };
  }

  async function updateDraft(input) {
    const body = validateCommand(input, true);
    const command = { ...input, body };
    await assertStorageAvailable(storage);
    const writeAt = captureWriteAt(now);
    if (typeof storage.getCurrentDraft !== 'function') {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    let lookup;
    try {
      lookup = await storage.getCurrentDraft({
        id: command.id,
        tenantId: command.tenantId,
        authorUserId: command.actorId
      });
    } catch (_error) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    validateLookupResult(lookup);
    if (lookup.records.length === 0) fail('BUDGET_DRAFT_NOT_FOUND');
    if (lookup.records.length !== 1) fail('BUDGET_STORAGE_UNAVAILABLE');
    const current = currentRecordInScope(lookup.records[0], command);
    const snapshots = await resolveReferences(referenceServiceFactory, command, writeAt);
    await assertNoPromotionLink(storage, command, command.id, current);
    try {
      validateBudgetV2StoredRecord(current, writeAt);
    } catch (_error) {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    if (current.version === MAX_VERSION) fail('BUDGET_VERSION_LIMIT');
    if (current.version !== command.body.expectedVersion) fail('BUDGET_VERSION_CONFLICT');
    const nextVersion = current.version + 1;
    const nextRecord = buildRecord({
      id: command.id,
      input: command,
      snapshots,
      version: nextVersion,
      createdAt: current.createdAt,
      writeAt
    });
    if (typeof storage.replaceCurrentDraft !== 'function') {
      fail('BUDGET_STORAGE_UNAVAILABLE');
    }
    let result;
    try {
      result = await storage.replaceCurrentDraft({
        id: command.id,
        tenantId: command.tenantId,
        authorUserId: command.actorId,
        expectedVersion: command.body.expectedVersion,
        nextRecord: clone(nextRecord),
        audit: buildAudit('budget_v2_draft_updated', command.id, nextVersion, writeAt)
      });
    } catch (_error) {
      fail('BUDGET_WRITE_UNCERTAIN', command.id);
    }
    validateWriteResult(result, 'updated', command.id, nextVersion);
    return { success: true, contractVersion: 2, data: summary(nextRecord) };
  }

  return Object.freeze({ createDraft, updateDraft });
}

module.exports = {
  BudgetV2WriteError,
  createBudgetV2WriteService
};

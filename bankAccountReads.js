'use strict';

const { types: { isProxy } } = require('node:util');
const {
  ACCOUNT_CLASSIFICATIONS,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  ISO_4217_CODES,
  MAX_LABEL_LENGTH,
  projectBankAccountSummaryV1
} = require('./bankAccountContracts');
const {
  BankAccountReferenceError,
  READ_OPERATION,
  REQUIRED_CAPABILITY,
  REQUIRED_PERMISSION
} = require('./bankAccountReferences');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_CANDIDATE_HANDLES = MAX_LIMIT + 1;
const DEFAULT_RESOLUTION_TIMEOUT_MS = 1000;
const MAX_RESOLUTION_TIMEOUT_MS = 1000;
const MAX_CONCURRENT_RESOLUTIONS = 4;
const MAX_CURSOR_LENGTH = 4096;
const MAX_CURSOR_AGE_MS = 30 * 60 * 1000;
const MAX_CONTEXT_VALUES = 64;
const MAX_TOTAL_COUNT = Number.MAX_SAFE_INTEGER;
const CURSOR_VERSION = 1;
const SORT_VERSION = 'INTERNAL_LABEL_ACCOUNT_ID_V1';
const TOTAL_SCOPE = 'authorized_filtered';

const REFERENCE_ERROR_CODES = new Set([
  'BANK_ACCOUNT_REQUEST_INVALID',
  'BANK_ACCOUNT_REFERENCE_INVALID',
  'BANK_ACCOUNT_REFERENCE_UNAVAILABLE',
  'BANK_ACCOUNT_ACCESS_DENIED',
  'BANK_ACCOUNT_RELATION_INVALID'
]);
const READ_ERROR_CODES = new Set([
  'BANK_ACCOUNT_REQUEST_INVALID',
  'BANK_ACCOUNT_ACCESS_DENIED',
  'BANK_ACCOUNT_CURSOR_INVALID',
  'BANK_ACCOUNT_LIST_UNAVAILABLE',
  'BANK_ACCOUNT_LIST_INVALID',
  'BANK_ACCOUNT_REFERENCE_INVALID',
  'BANK_ACCOUNT_REFERENCE_UNAVAILABLE',
  'BANK_ACCOUNT_RELATION_INVALID'
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCESS_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CURSOR_PATTERN = /^[A-Za-z0-9._~-]+$/;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const FACTORY_KEYS = Object.freeze([
  'referencePolicyService', 'listResolver', 'cursorCodec', 'resolutionTimeoutMs'
]);
const CONTEXT_KEYS = Object.freeze([
  'tenantId', 'actorId', 'operation', 'requestAt', 'permissions', 'capabilities'
]);
const READ_REQUEST_KEYS = Object.freeze(['bankAccountId', 'context']);
const LIST_REQUEST_KEYS = Object.freeze(['context', 'filters', 'cursor', 'limit']);
const FILTER_KEYS = Object.freeze([
  'holderEntityId', 'financialInstitutionId', 'accountType',
  'currency', 'status', 'classification'
]);
const LIST_RESULT_KEYS = Object.freeze([
  'available', 'listRevision', 'records', 'hasMore', 'provenTotal'
]);
const HANDLE_KEYS = Object.freeze([
  'bankAccountId', 'internalLabelOrder', 'sourceRevision'
]);
const AFTER_KEYS = Object.freeze([
  'internalLabelOrder', 'bankAccountId', 'listRevision'
]);
const CURSOR_PAYLOAD_KEYS = Object.freeze([
  'cursorVersion', 'tenantId', 'actorId', 'operation', 'normalizedFilters',
  'limit', 'sortVersion', 'listRevision', 'afterInternalLabelOrder',
  'afterBankAccountId', 'authorizedCount', 'issuedAt', 'expiresAt'
]);
const PROVEN_TOTAL_KEYS = Object.freeze([
  'tenantId', 'actorId', 'filters', 'listRevision', 'sourceRevision', 'scope', 'count'
]);
const CODEC_KEYS = Object.freeze(['encode', 'decode']);
const POLICY_SERVICE_KEYS = Object.freeze(['resolveReadableBankAccountSummary']);

const CURRENCIES = new Set(ISO_4217_CODES);

class BankAccountReadError extends Error {
  constructor(code) {
    super('Bank account read request could not be completed');
    Object.defineProperties(this, {
      name: { value: 'BankAccountReadError', configurable: true },
      code: { value: code, enumerable: true }
    });
  }
}

const fail = code => { throw new BankAccountReadError(code); };

function safeKnownErrorCode(error, ErrorType, allowedCodes) {
  try {
    if (error === null
      || (typeof error !== 'object' && typeof error !== 'function')
      || isProxy(error)
      || !(error instanceof ErrorType)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    return typeof descriptor.value === 'string' && allowedCodes.has(descriptor.value)
      ? descriptor.value
      : null;
  } catch (_error) {
    return null;
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readClosedFields(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainRecord(value)) return null;
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (_error) {
    return null;
  }
  if (!ownKeys.every(key => typeof key === 'string' && allowedKeys.includes(key))
    || !requiredKeys.every(key => ownKeys.includes(key))) return null;

  const fields = Object.create(null);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
    Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true });
  }
  return fields;
}

function isReferenceId(value) {
  return typeof value === 'string' && REFERENCE_ID_PATTERN.test(value);
}

function isDisplayText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_LABEL_LENGTH
    && value === value.trim()
    && value.normalize('NFC') === value
    && !UNSAFE_TEXT_PATTERN.test(value);
}

function isCanonicalInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value.endsWith('.000Z')
    ? canonical === value
    : canonical.replace('.000Z', 'Z') === value;
}

function validateAccessSet(value) {
  if (isProxy(value) || !Array.isArray(value) || value.length > MAX_CONTEXT_VALUES) return null;
  const copy = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
    const entry = descriptor.value;
    if (typeof entry !== 'string' || !ACCESS_VALUE_PATTERN.test(entry) || seen.has(entry)) return null;
    seen.add(entry);
    copy.push(entry);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => {
    if (key === 'length') return false;
    return typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length;
  })) return null;
  return Object.freeze(copy);
}

function validateContext(value) {
  const fields = readClosedFields(value, CONTEXT_KEYS);
  if (!fields
    || !isReferenceId(fields.tenantId)
    || !isReferenceId(fields.actorId)
    || fields.operation !== READ_OPERATION
    || !isCanonicalInstant(fields.requestAt)) fail('BANK_ACCOUNT_REQUEST_INVALID');
  const permissions = validateAccessSet(fields.permissions);
  const capabilities = validateAccessSet(fields.capabilities);
  if (!permissions || !capabilities) fail('BANK_ACCOUNT_REQUEST_INVALID');
  return Object.freeze({
    tenantId: fields.tenantId,
    actorId: fields.actorId,
    operation: READ_OPERATION,
    requestAt: fields.requestAt,
    permissions,
    capabilities
  });
}

function requireReadAccess(context) {
  if (!context.permissions.includes(REQUIRED_PERMISSION)
    || !context.capabilities.includes(REQUIRED_CAPABILITY)) {
    fail('BANK_ACCOUNT_ACCESS_DENIED');
  }
}

function validateReadRequest(input) {
  const fields = readClosedFields(input, READ_REQUEST_KEYS);
  if (!fields || typeof fields.bankAccountId !== 'string'
    || !UUID_PATTERN.test(fields.bankAccountId)) fail('BANK_ACCOUNT_REQUEST_INVALID');
  return Object.freeze({
    bankAccountId: fields.bankAccountId,
    context: validateContext(fields.context)
  });
}

function validateFilterValue(key, value) {
  if (key === 'holderEntityId' || key === 'financialInstitutionId') return isReferenceId(value);
  if (key === 'accountType') return ACCOUNT_TYPES.includes(value);
  if (key === 'currency') return typeof value === 'string' && CURRENCIES.has(value);
  if (key === 'status') return ACCOUNT_STATUSES.includes(value);
  if (key === 'classification') return ACCOUNT_CLASSIFICATIONS.includes(value);
  return false;
}

function normalizeFilters(value) {
  const fields = readClosedFields(value, FILTER_KEYS, []);
  if (!fields) fail('BANK_ACCOUNT_REQUEST_INVALID');
  const normalized = {};
  for (const key of FILTER_KEYS) {
    if (!Object.hasOwn(fields, key)) continue;
    if (!validateFilterValue(key, fields[key])) fail('BANK_ACCOUNT_REQUEST_INVALID');
    normalized[key] = fields[key];
  }
  return Object.freeze(normalized);
}

function validateListRequest(input) {
  const fields = readClosedFields(input, LIST_REQUEST_KEYS, ['context']);
  if (!fields) fail('BANK_ACCOUNT_REQUEST_INVALID');
  const context = validateContext(fields.context);
  requireReadAccess(context);
  const limit = Object.hasOwn(fields, 'limit') ? fields.limit : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    fail('BANK_ACCOUNT_REQUEST_INVALID');
  }
  const filters = Object.hasOwn(fields, 'filters') ? normalizeFilters(fields.filters) : Object.freeze({});
  const cursor = Object.hasOwn(fields, 'cursor') ? fields.cursor : null;
  if (cursor !== null && (typeof cursor !== 'string'
    || cursor.length < 1
    || cursor.length > MAX_CURSOR_LENGTH
    || !CURSOR_PATTERN.test(cursor))) fail('BANK_ACCOUNT_CURSOR_INVALID');
  return Object.freeze({
    context,
    filters,
    cursor,
    limit
  });
}

function readFactory(options) {
  const fields = readClosedFields(
    options,
    FACTORY_KEYS,
    ['referencePolicyService', 'listResolver', 'cursorCodec']
  );
  if (!fields || typeof fields.listResolver !== 'function') {
    fail('BANK_ACCOUNT_REQUEST_INVALID');
  }
  const policy = readClosedFields(fields.referencePolicyService, POLICY_SERVICE_KEYS);
  const codec = readClosedFields(fields.cursorCodec, CODEC_KEYS);
  if (!policy
    || typeof policy.resolveReadableBankAccountSummary !== 'function'
    || !codec
    || typeof codec.encode !== 'function'
    || typeof codec.decode !== 'function') fail('BANK_ACCOUNT_REQUEST_INVALID');

  const timeout = Object.hasOwn(fields, 'resolutionTimeoutMs')
    ? fields.resolutionTimeoutMs
    : DEFAULT_RESOLUTION_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_RESOLUTION_TIMEOUT_MS) {
    fail('BANK_ACCOUNT_REQUEST_INVALID');
  }
  return Object.freeze({
    resolveReadableBankAccountSummary: policy.resolveReadableBankAccountSummary,
    listResolver: fields.listResolver,
    cursorEncode: codec.encode,
    cursorDecode: codec.decode,
    resolutionTimeoutMs: timeout
  });
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, character => character.codePointAt(0));
  const rightPoints = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] < rightPoints[index] ? -1 : 1;
  }
  if (leftPoints.length === rightPoints.length) return 0;
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

function compareHandles(left, right) {
  const labelOrder = compareCodePoints(left.internalLabelOrder, right.internalLabelOrder);
  if (labelOrder !== 0) return labelOrder;
  if (left.bankAccountId === right.bankAccountId) return 0;
  return left.bankAccountId < right.bankAccountId ? -1 : 1;
}

function readArrayValues(value, maximum) {
  if (isProxy(value) || !Array.isArray(value) || value.length > maximum) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => {
    if (key === 'length') return false;
    return typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length;
  })) return null;
  const records = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
    records.push(descriptor.value);
  }
  return records;
}

function validateHandles(value, candidateLimit) {
  const records = readArrayValues(value, candidateLimit);
  if (!records) fail('BANK_ACCOUNT_LIST_INVALID');
  const handles = [];
  const accountIds = new Set();
  for (const record of records) {
    const fields = readClosedFields(record, HANDLE_KEYS);
    if (!fields
      || typeof fields.bankAccountId !== 'string'
      || !UUID_PATTERN.test(fields.bankAccountId)
      || !isDisplayText(fields.internalLabelOrder)
      || !isReferenceId(fields.sourceRevision)
      || accountIds.has(fields.bankAccountId)) fail('BANK_ACCOUNT_LIST_INVALID');
    const handle = Object.freeze({
      bankAccountId: fields.bankAccountId,
      internalLabelOrder: fields.internalLabelOrder,
      sourceRevision: fields.sourceRevision
    });
    if (handles.length > 0 && compareHandles(handles.at(-1), handle) >= 0) {
      fail('BANK_ACCOUNT_LIST_INVALID');
    }
    accountIds.add(handle.bankAccountId);
    handles.push(handle);
  }
  return Object.freeze(handles);
}

function validateListEnvelope(value, candidateLimit, pageLimit) {
  const fields = readClosedFields(value, LIST_RESULT_KEYS);
  if (!fields || typeof fields.available !== 'boolean') fail('BANK_ACCOUNT_LIST_INVALID');
  if (fields.available === false) fail('BANK_ACCOUNT_LIST_UNAVAILABLE');
  if (!isReferenceId(fields.listRevision) || typeof fields.hasMore !== 'boolean') {
    fail('BANK_ACCOUNT_LIST_INVALID');
  }
  const records = validateHandles(fields.records, candidateLimit);
  if (records.length > pageLimit && fields.hasMore !== true) fail('BANK_ACCOUNT_LIST_INVALID');
  if (fields.hasMore === true && records.length === 0) fail('BANK_ACCOUNT_LIST_INVALID');
  if (fields.hasMore === true && records.length !== candidateLimit) {
    fail('BANK_ACCOUNT_LIST_INVALID');
  }
  return Object.freeze({
    listRevision: fields.listRevision,
    records,
    hasMore: fields.hasMore,
    provenTotal: fields.provenTotal
  });
}

function sameFilters(left, right) {
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function validateCursorPayload(value, request) {
  const fields = readClosedFields(value, CURSOR_PAYLOAD_KEYS);
  if (!fields) fail('BANK_ACCOUNT_CURSOR_INVALID');
  let normalizedFilters;
  try {
    normalizedFilters = normalizeFilters(fields.normalizedFilters);
  } catch (_error) {
    fail('BANK_ACCOUNT_CURSOR_INVALID');
  }
  if (!isCanonicalInstant(fields.issuedAt) || !isCanonicalInstant(fields.expiresAt)) {
    fail('BANK_ACCOUNT_CURSOR_INVALID');
  }
  const issuedAtMs = Date.parse(fields.issuedAt);
  const expiresAtMs = Date.parse(fields.expiresAt);
  const requestAtMs = Date.parse(request.context.requestAt);
  if (fields.cursorVersion !== CURSOR_VERSION
    || fields.tenantId !== request.context.tenantId
    || fields.actorId !== request.context.actorId
    || fields.operation !== READ_OPERATION
    || !sameFilters(normalizedFilters, request.filters)
    || fields.limit !== request.limit
    || fields.sortVersion !== SORT_VERSION
    || !isReferenceId(fields.listRevision)
    || !isDisplayText(fields.afterInternalLabelOrder)
    || typeof fields.afterBankAccountId !== 'string'
    || !UUID_PATTERN.test(fields.afterBankAccountId)
    || !Number.isSafeInteger(fields.authorizedCount)
    || fields.authorizedCount < 1
    || fields.authorizedCount > MAX_TOTAL_COUNT
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MAX_CURSOR_AGE_MS
    || issuedAtMs > requestAtMs
    || requestAtMs > expiresAtMs) fail('BANK_ACCOUNT_CURSOR_INVALID');

  return Object.freeze({
    listRevision: fields.listRevision,
    authorizedCount: fields.authorizedCount,
    after: Object.freeze({
      internalLabelOrder: fields.afterInternalLabelOrder,
      bankAccountId: fields.afterBankAccountId,
      listRevision: fields.listRevision
    })
  });
}

async function decodeCursor(cursorDecode, request) {
  if (request.cursor === null) {
    return Object.freeze({ listRevision: null, authorizedCount: 0, after: null });
  }
  try {
    const payload = await cursorDecode(request.cursor);
    return validateCursorPayload(payload, request);
  } catch (_error) {
    fail('BANK_ACCOUNT_CURSOR_INVALID');
  }
}

function addMinutes(instant, milliseconds) {
  return new Date(Date.parse(instant) + milliseconds).toISOString().replace('.000Z', 'Z');
}

function validCursorToken(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_CURSOR_LENGTH
    && CURSOR_PATTERN.test(value);
}

async function encodeCursor(cursorEncode, request, envelope, lastHandle, authorizedCount) {
  const payload = Object.freeze({
    cursorVersion: CURSOR_VERSION,
    tenantId: request.context.tenantId,
    actorId: request.context.actorId,
    operation: READ_OPERATION,
    normalizedFilters: request.filters,
    limit: request.limit,
    sortVersion: SORT_VERSION,
    listRevision: envelope.listRevision,
    afterInternalLabelOrder: lastHandle.internalLabelOrder,
    afterBankAccountId: lastHandle.bankAccountId,
    authorizedCount,
    issuedAt: request.context.requestAt,
    expiresAt: addMinutes(request.context.requestAt, MAX_CURSOR_AGE_MS)
  });
  let cursor;
  try {
    cursor = await cursorEncode(payload);
  } catch (_error) {
    fail('BANK_ACCOUNT_CURSOR_INVALID');
  }
  if (!validCursorToken(cursor)) fail('BANK_ACCOUNT_CURSOR_INVALID');
  return cursor;
}

async function callListResolver(listResolver, queryFields, timeoutMs, candidateLimit, pageLimit) {
  const controller = new AbortController();
  const query = Object.freeze({ ...queryFields, signal: controller.signal });
  const sourcePromise = Promise.resolve().then(() => listResolver(query));
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([sourcePromise, timeoutPromise]);
    return validateListEnvelope(result, candidateLimit, pageLimit);
  } catch (error) {
    const code = safeKnownErrorCode(error, BankAccountReadError, READ_ERROR_CODES);
    if (code !== null) throw new BankAccountReadError(code);
    fail('BANK_ACCOUNT_LIST_UNAVAILABLE');
  } finally {
    clearTimeout(timeoutId);
  }
}

function matchesFilters(summary, filters) {
  return (!Object.hasOwn(filters, 'holderEntityId')
      || summary.holderEntity.id === filters.holderEntityId)
    && (!Object.hasOwn(filters, 'financialInstitutionId')
      || summary.financialInstitution.id === filters.financialInstitutionId)
    && (!Object.hasOwn(filters, 'accountType') || summary.accountType === filters.accountType)
    && (!Object.hasOwn(filters, 'currency') || summary.currency === filters.currency)
    && (!Object.hasOwn(filters, 'status') || summary.status === filters.status)
    && (!Object.hasOwn(filters, 'classification')
      || summary.classification === filters.classification);
}

function sanitizeReferenceError(error) {
  const referenceCode = safeKnownErrorCode(
    error,
    BankAccountReferenceError,
    REFERENCE_ERROR_CODES
  );
  if (referenceCode !== null) return new BankAccountReferenceError(referenceCode);
  const readCode = safeKnownErrorCode(error, BankAccountReadError, READ_ERROR_CODES);
  if (readCode !== null) return new BankAccountReadError(readCode);
  return new BankAccountReadError('BANK_ACCOUNT_REFERENCE_UNAVAILABLE');
}

function detachedSummary(value) {
  try {
    return projectBankAccountSummaryV1(value);
  } catch (_error) {
    fail('BANK_ACCOUNT_REFERENCE_INVALID');
  }
}

function createBoundedScheduler(limit) {
  const queue = [];
  let active = 0;

  function drain() {
    while (active < limit && queue.length > 0) {
      const entry = queue.shift();
      if (entry.cancelled) continue;
      entry.started = true;
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return task => {
    const entry = { task, resolve: null, reject: null, started: false, cancelled: false };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      queue.push(entry);
      drain();
    });
    return Object.freeze({
      promise,
      cancel(errorCode) {
        if (entry.started || entry.cancelled) return false;
        entry.cancelled = true;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        entry.reject(new BankAccountReadError(errorCode));
        return true;
      }
    });
  };
}

async function callReferenceWithTimeout(schedule, resolver, request, timeoutMs, timeoutCode) {
  let timedOut = false;
  const scheduledResolution = schedule(() => {
    if (timedOut) throw new BankAccountReadError(timeoutCode);
    return resolver(request);
  });
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      scheduledResolution.cancel(timeoutCode);
      reject(new BankAccountReadError(timeoutCode));
    }, timeoutMs);
  });
  try {
    return await Promise.race([scheduledResolution.promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveHandles(
  handles,
  request,
  resolveReadableBankAccountSummary,
  resolutionScheduler,
  timeoutMs
) {
  const results = new Array(handles.length).fill(null);
  let nextIndex = 0;
  let firstFailure = null;

  async function resolveWithTimeout(handle) {
    return callReferenceWithTimeout(
      resolutionScheduler,
      resolveReadableBankAccountSummary,
      Object.freeze({ bankAccountId: handle.bankAccountId, context: request.context }),
      timeoutMs,
      'BANK_ACCOUNT_LIST_UNAVAILABLE'
    );
  }

  async function worker() {
    while (firstFailure === null) {
      const index = nextIndex;
      if (index >= handles.length) return;
      nextIndex += 1;
      const handle = handles[index];
      try {
        const source = await resolveWithTimeout(handle);
        const summary = detachedSummary(source);
        if (summary.bankAccountId !== handle.bankAccountId
          || summary.internalLabel !== handle.internalLabelOrder
          || summary.sourceRevision !== handle.sourceRevision) {
          throw new BankAccountReadError('BANK_ACCOUNT_LIST_INVALID');
        }
        if (matchesFilters(summary, request.filters)) results[index] = summary;
      } catch (error) {
        const referenceCode = safeKnownErrorCode(
          error,
          BankAccountReferenceError,
          REFERENCE_ERROR_CODES
        );
        if (referenceCode === 'BANK_ACCOUNT_ACCESS_DENIED') {
          results[index] = null;
          continue;
        }
        firstFailure = sanitizeReferenceError(error);
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_RESOLUTIONS, handles.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstFailure !== null) throw firstFailure;
  return Object.freeze(results.filter(Boolean));
}

function qualifyTotal(value, envelope, request, cursorState, visibleWindowCount, pageCount) {
  if (value === null) return Object.freeze({ totalCount: null, totalStatus: 'unavailable' });
  const fields = readClosedFields(value, PROVEN_TOTAL_KEYS);
  if (!fields) return Object.freeze({ totalCount: null, totalStatus: 'unavailable' });
  let filters;
  try {
    filters = normalizeFilters(fields.filters);
  } catch (_error) {
    return Object.freeze({ totalCount: null, totalStatus: 'unavailable' });
  }
  const cumulativeVisibleWindowCount = cursorState.authorizedCount + visibleWindowCount;
  const cumulativePageCount = cursorState.authorizedCount + pageCount;
  if (fields.tenantId !== request.context.tenantId
    || fields.actorId !== request.context.actorId
    || !sameFilters(filters, request.filters)
    || fields.listRevision !== envelope.listRevision
    || !isReferenceId(fields.sourceRevision)
    || fields.scope !== TOTAL_SCOPE
    || !Number.isSafeInteger(fields.count)
    || fields.count < 0
    || fields.count > MAX_TOTAL_COUNT
    || (envelope.hasMore
      ? fields.count < cumulativeVisibleWindowCount
      : fields.count !== cumulativePageCount)) {
    return Object.freeze({ totalCount: null, totalStatus: 'unavailable' });
  }
  return Object.freeze({ totalCount: fields.count, totalStatus: 'proven' });
}

function createBankAccountReadService(options) {
  const factory = readFactory(options);
  const resolutionScheduler = createBoundedScheduler(MAX_CONCURRENT_RESOLUTIONS);

  async function readBankAccountSummary(input) {
    const request = validateReadRequest(input);
    let result;
    try {
      result = await callReferenceWithTimeout(
        resolutionScheduler,
        factory.resolveReadableBankAccountSummary,
        request,
        factory.resolutionTimeoutMs,
        'BANK_ACCOUNT_REFERENCE_UNAVAILABLE'
      );
    } catch (error) {
      throw sanitizeReferenceError(error);
    }
    return detachedSummary(result);
  }

  async function listBankAccountSummaries(input) {
    const request = validateListRequest(input);
    const cursorState = await decodeCursor(factory.cursorDecode, request);
    const candidateLimit = request.limit + 1;
    const envelope = await callListResolver(
      factory.listResolver,
      {
        tenantId: request.context.tenantId,
        actorId: request.context.actorId,
        operation: request.context.operation,
        requestAt: request.context.requestAt,
        filters: request.filters,
        after: cursorState.after,
        candidateLimit
      },
      factory.resolutionTimeoutMs,
      candidateLimit,
      request.limit
    );
    if (cursorState.listRevision !== null
      && cursorState.listRevision !== envelope.listRevision) fail('BANK_ACCOUNT_CURSOR_INVALID');
    if (cursorState.after !== null
      && envelope.records.length > 0
      && compareHandles(envelope.records[0], cursorState.after) <= 0) {
      fail('BANK_ACCOUNT_LIST_INVALID');
    }

    const candidateHandles = envelope.records;
    const resolvedCandidates = await resolveHandles(
      candidateHandles,
      request,
      factory.resolveReadableBankAccountSummary,
      resolutionScheduler,
      factory.resolutionTimeoutMs
    );
    const completeVisibleWindow = resolvedCandidates.length === candidateHandles.length;
    const pageItems = Object.freeze(resolvedCandidates.slice(0, request.limit));
    const hasMore = resolvedCandidates.length > request.limit;
    const total = completeVisibleWindow
      ? qualifyTotal(
        envelope.provenTotal,
        envelope,
        request,
        cursorState,
        resolvedCandidates.length,
        pageItems.length
      )
      : Object.freeze({ totalCount: null, totalStatus: 'unavailable' });
    const nextCursor = hasMore
      ? await encodeCursor(
        factory.cursorEncode,
        request,
        envelope,
        candidateHandles[request.limit - 1],
        cursorState.authorizedCount + pageItems.length
      )
      : null;
    return Object.freeze({
      items: pageItems,
      pageCount: pageItems.length,
      hasMore,
      nextCursor,
      listRevision: envelope.listRevision,
      totalCount: total.totalCount,
      totalStatus: total.totalStatus
    });
  }

  return Object.freeze({ readBankAccountSummary, listBankAccountSummaries });
}

module.exports = {
  BankAccountReadError,
  CURSOR_VERSION,
  DEFAULT_LIMIT,
  DEFAULT_RESOLUTION_TIMEOUT_MS,
  FILTER_KEYS,
  MAX_CANDIDATE_HANDLES,
  MAX_CONCURRENT_RESOLUTIONS,
  MAX_CURSOR_AGE_MS,
  MAX_LIMIT,
  MAX_RESOLUTION_TIMEOUT_MS,
  SORT_VERSION,
  TOTAL_SCOPE,
  createBankAccountReadService
};

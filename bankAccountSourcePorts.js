'use strict';

const { types: { isProxy } } = require('node:util');
const {
  ACCOUNT_CLASSIFICATIONS,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  INSTITUTION_TYPES,
  ISO_4217_CODES,
  MAX_LABEL_LENGTH,
  projectBankAccountSummaryV1,
  validateBankAccountSummaryV1
} = require('./bankAccountContracts');
const { READ_OPERATION } = require('./bankAccountReferences');

const MAX_CANDIDATE_HANDLES = 51;
const MAX_SOURCE_RECORDS = 2;
const TOTAL_SCOPE = 'authorized_filtered';
const CONTRACT_VERSION = 'M3S-CB-1-D-A-001-V0.1';
const DATA_CLASSIFICATION = 'MASKED_ORGANIZATIONAL_METADATA_ONLY';
const ENVIRONMENT_CLASS = 'FICTIONAL_TEST_DOUBLE';
const UNAVAILABLE_REVISION = 'source-unavailable';

const SOURCE_CAPABILITIES = Object.freeze([
  'ACCOUNT_EXACT_READ',
  'RELATION_REVISION_READ',
  'HANDLE_LIST_LIMIT_51',
  'AUTHORIZED_FILTERED_TOTAL',
  'STABLE_LIST_REVISION'
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const FACTORY_KEYS = Object.freeze([
  'accountSource', 'relationSources', 'listSource', 'totalSource', 'sourceProbe'
]);
const RELATION_SOURCE_KEYS = Object.freeze(['entity', 'institution', 'agent']);
const ACCOUNT_QUERY_KEYS = Object.freeze([
  'bankAccountId', 'tenantId', 'operation', 'requestAt'
]);
const RELATION_QUERY_KEYS = Object.freeze([
  'id', 'tenantId', 'operation', 'requestAt', 'sourceRevision'
]);
const LIST_QUERY_KEYS = Object.freeze([
  'tenantId', 'actorId', 'operation', 'requestAt', 'filters', 'after',
  'candidateLimit', 'signal'
]);
const TOTAL_QUERY_KEYS = Object.freeze([
  'tenantId', 'actorId', 'operation', 'requestAt', 'filters', 'listRevision'
]);
const FILTER_KEYS = Object.freeze([
  'holderEntityId', 'financialInstitutionId', 'accountType',
  'currency', 'status', 'classification'
]);
const AFTER_KEYS = Object.freeze([
  'internalLabelOrder', 'bankAccountId', 'listRevision'
]);
const RESOLVER_RESULT_KEYS = Object.freeze(['available', 'records']);
const ACCOUNT_RECORD_KEYS = Object.freeze(['summary', 'visible']);
const RELATION_RECORD_KEYS = Object.freeze([
  'id', 'tenantId', 'labelSnapshot', 'sourceRevision', 'active', 'visible',
  'classification', 'effectiveFrom', 'effectiveTo'
]);
const INSTITUTION_RECORD_KEYS = Object.freeze([
  ...RELATION_RECORD_KEYS, 'countryId', 'institutionType'
]);
const SOURCE_LIST_RESULT_KEYS = Object.freeze([
  'available', 'listRevision', 'records', 'hasMore'
]);
const HANDLE_KEYS = Object.freeze([
  'bankAccountId', 'internalLabelOrder', 'sourceRevision'
]);
const TOTAL_RESULT_KEYS = Object.freeze(['available', 'provenTotal']);
const PROVEN_TOTAL_KEYS = Object.freeze([
  'tenantId', 'actorId', 'filters', 'listRevision', 'sourceRevision', 'scope', 'count'
]);
const PROBE_KEYS = Object.freeze([
  'sourceId', 'contractVersion', 'dataClassification', 'environmentClass',
  'observedAt', 'available', 'capabilities'
]);

const CURRENCIES = new Set(ISO_4217_CODES);

class BankAccountSourceError extends Error {
  constructor(code) {
    super('Bank account source request could not be completed');
    Object.defineProperties(this, {
      name: { value: 'BankAccountSourceError', configurable: true },
      code: { value: code, enumerable: true }
    });
  }
}

const fail = code => { throw new BankAccountSourceError(code); };

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (_error) {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function readClosedFields(value, keys, requiredKeys = keys) {
  if (!isPlainRecord(value)) return null;
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (_error) {
    return null;
  }
  if (!ownKeys.every(key => typeof key === 'string' && keys.includes(key))
    || !requiredKeys.every(key => ownKeys.includes(key))) return null;

  const fields = Object.create(null);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
    Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true });
  }
  return fields;
}

function readArrayValues(value, maximum) {
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)
    || value.length > maximum) return null;
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (_error) {
    return null;
  }
  if (ownKeys.some(key => {
    if (key === 'length') return false;
    return typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)
      || Number(key) >= value.length;
  })) return null;
  const copy = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
    copy.push(descriptor.value);
  }
  return copy;
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

function isIsoDateOrNull(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 10) === value;
}

function copyAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(copyAndFreeze));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = copyAndFreeze(value[key]);
  return Object.freeze(copy);
}

function validateFactory(options) {
  const fields = readClosedFields(options, FACTORY_KEYS);
  if (!fields
    || typeof fields.accountSource !== 'function'
    || typeof fields.listSource !== 'function'
    || typeof fields.totalSource !== 'function'
    || typeof fields.sourceProbe !== 'function') fail('BANK_ACCOUNT_SOURCE_REQUEST_INVALID');
  const relations = readClosedFields(fields.relationSources, RELATION_SOURCE_KEYS);
  if (!relations || RELATION_SOURCE_KEYS.some(key => typeof relations[key] !== 'function')) {
    fail('BANK_ACCOUNT_SOURCE_REQUEST_INVALID');
  }
  return Object.freeze({
    accountSource: fields.accountSource,
    relationSources: Object.freeze({
      entity: relations.entity,
      institution: relations.institution,
      agent: relations.agent
    }),
    listSource: fields.listSource,
    totalSource: fields.totalSource,
    sourceProbe: fields.sourceProbe
  });
}

function validateCapabilities(value, available) {
  const capabilities = readArrayValues(value, SOURCE_CAPABILITIES.length);
  if (!capabilities
    || capabilities.some(item => typeof item !== 'string')
    || new Set(capabilities).size !== capabilities.length) {
    fail('BANK_ACCOUNT_SOURCE_INVALID');
  }
  if (available === false) {
    if (capabilities.length !== 0) fail('BANK_ACCOUNT_SOURCE_INVALID');
    return Object.freeze([]);
  }
  if (capabilities.length !== SOURCE_CAPABILITIES.length
    || SOURCE_CAPABILITIES.some(item => !capabilities.includes(item))) {
    fail('BANK_ACCOUNT_SOURCE_INVALID');
  }
  return Object.freeze([...SOURCE_CAPABILITIES]);
}

function inspectProbe(sourceProbe) {
  let result;
  try {
    result = sourceProbe();
  } catch (_error) {
    fail('BANK_ACCOUNT_SOURCE_UNAVAILABLE');
  }
  const fields = readClosedFields(result, PROBE_KEYS);
  if (!fields
    || !isReferenceId(fields.sourceId)
    || fields.contractVersion !== CONTRACT_VERSION
    || fields.dataClassification !== DATA_CLASSIFICATION
    || fields.environmentClass !== ENVIRONMENT_CLASS
    || !isCanonicalInstant(fields.observedAt)
    || typeof fields.available !== 'boolean') fail('BANK_ACCOUNT_SOURCE_INVALID');
  validateCapabilities(fields.capabilities, fields.available);
  return fields.available;
}

function validateAccountQuery(value) {
  const fields = readClosedFields(value, ACCOUNT_QUERY_KEYS);
  if (!fields
    || typeof fields.bankAccountId !== 'string'
    || !UUID_PATTERN.test(fields.bankAccountId)
    || !isReferenceId(fields.tenantId)
    || fields.operation !== READ_OPERATION
    || !isCanonicalInstant(fields.requestAt)) fail('BANK_ACCOUNT_SOURCE_REQUEST_INVALID');
  return Object.freeze({
    bankAccountId: fields.bankAccountId,
    tenantId: fields.tenantId,
    operation: READ_OPERATION,
    requestAt: fields.requestAt
  });
}

function validateRelationQuery(value) {
  const fields = readClosedFields(value, RELATION_QUERY_KEYS);
  if (!fields
    || !isReferenceId(fields.id)
    || !isReferenceId(fields.tenantId)
    || fields.operation !== READ_OPERATION
    || !isCanonicalInstant(fields.requestAt)
    || !isReferenceId(fields.sourceRevision)) fail('BANK_ACCOUNT_SOURCE_REQUEST_INVALID');
  return Object.freeze({
    id: fields.id,
    tenantId: fields.tenantId,
    operation: READ_OPERATION,
    requestAt: fields.requestAt,
    sourceRevision: fields.sourceRevision
  });
}

function validateFilters(value) {
  const fields = readClosedFields(value, FILTER_KEYS, []);
  if (!fields) fail('BANK_ACCOUNT_SOURCE_REQUEST_INVALID');
  for (const key of Object.keys(fields)) {
    const item = fields[key];
    const valid = key === 'holderEntityId' || key === 'financialInstitutionId'
      ? isReferenceId(item)
      : key === 'accountType'
        ? ACCOUNT_TYPES.includes(item)
        : key === 'currency'
          ? typeof item === 'string' && CURRENCIES.has(item)
          : key === 'status'
            ? ACCOUNT_STATUSES.includes(item)
            : ACCOUNT_CLASSIFICATIONS.includes(item);
    if (!valid) fail('BANK_ACCOUNT_SOURCE_REQUEST_INVALID');
  }
  return copyAndFreeze(fields);
}

function validateAfter(value) {
  if (value === null) return null;
  const fields = readClosedFields(value, AFTER_KEYS);
  if (!fields
    || !isDisplayText(fields.internalLabelOrder)
    || typeof fields.bankAccountId !== 'string'
    || !UUID_PATTERN.test(fields.bankAccountId)
    || !isReferenceId(fields.listRevision)) fail('BANK_ACCOUNT_SOURCE_REQUEST_INVALID');
  return Object.freeze({
    internalLabelOrder: fields.internalLabelOrder,
    bankAccountId: fields.bankAccountId,
    listRevision: fields.listRevision
  });
}

function readAbortState(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== AbortSignal.prototype
      || Reflect.ownKeys(value).some(key => typeof key === 'string')) return null;
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted');
    if (typeof descriptor?.get !== 'function'
      || typeof value.addEventListener !== 'function') return null;
    const aborted = descriptor.get.call(value);
    return typeof aborted === 'boolean' ? aborted : null;
  } catch (_error) {
    return null;
  }
}

function validateListQuery(value) {
  const fields = readClosedFields(value, LIST_QUERY_KEYS);
  const aborted = fields ? readAbortState(fields.signal) : null;
  if (!fields
    || !isReferenceId(fields.tenantId)
    || !isReferenceId(fields.actorId)
    || fields.operation !== READ_OPERATION
    || !isCanonicalInstant(fields.requestAt)
    || !Number.isInteger(fields.candidateLimit)
    || fields.candidateLimit < 2
    || fields.candidateLimit > MAX_CANDIDATE_HANDLES
    || aborted === null) fail('BANK_ACCOUNT_SOURCE_REQUEST_INVALID');
  if (aborted) fail('BANK_ACCOUNT_SOURCE_UNAVAILABLE');
  return Object.freeze({
    tenantId: fields.tenantId,
    actorId: fields.actorId,
    operation: READ_OPERATION,
    requestAt: fields.requestAt,
    filters: validateFilters(fields.filters),
    after: validateAfter(fields.after),
    candidateLimit: fields.candidateLimit,
    signal: fields.signal
  });
}

async function invoke(source, query) {
  try {
    return await source(query);
  } catch (_error) {
    fail('BANK_ACCOUNT_SOURCE_UNAVAILABLE');
  }
}

function validateAccountRecord(value) {
  const fields = readClosedFields(value, ACCOUNT_RECORD_KEYS);
  if (!fields || typeof fields.visible !== 'boolean') fail('BANK_ACCOUNT_SOURCE_INVALID');
  let summary;
  try {
    validateBankAccountSummaryV1(fields.summary);
    summary = projectBankAccountSummaryV1(fields.summary);
  } catch (_error) {
    fail('BANK_ACCOUNT_SOURCE_INVALID');
  }
  return Object.freeze({ summary, visible: fields.visible });
}

function validateRelationRecord(value, institution) {
  const keys = institution ? INSTITUTION_RECORD_KEYS : RELATION_RECORD_KEYS;
  const fields = readClosedFields(value, keys);
  if (!fields
    || !isReferenceId(fields.id)
    || !isReferenceId(fields.tenantId)
    || !isDisplayText(fields.labelSnapshot)
    || !isReferenceId(fields.sourceRevision)
    || typeof fields.active !== 'boolean'
    || typeof fields.visible !== 'boolean'
    || !ACCOUNT_CLASSIFICATIONS.includes(fields.classification)
    || !isIsoDateOrNull(fields.effectiveFrom)
    || !isIsoDateOrNull(fields.effectiveTo)
    || (fields.effectiveFrom !== null && fields.effectiveTo !== null
      && fields.effectiveTo < fields.effectiveFrom)) fail('BANK_ACCOUNT_SOURCE_INVALID');
  if (institution && (!isReferenceId(fields.countryId)
    || !INSTITUTION_TYPES.includes(fields.institutionType))) {
    fail('BANK_ACCOUNT_SOURCE_INVALID');
  }
  const record = {
    id: fields.id,
    tenantId: fields.tenantId,
    labelSnapshot: fields.labelSnapshot,
    sourceRevision: fields.sourceRevision,
    active: fields.active,
    visible: fields.visible,
    classification: fields.classification,
    effectiveFrom: fields.effectiveFrom,
    effectiveTo: fields.effectiveTo
  };
  if (institution) {
    record.countryId = fields.countryId;
    record.institutionType = fields.institutionType;
  }
  return Object.freeze(record);
}

function validateResolverEnvelope(value, recordValidator) {
  const fields = readClosedFields(value, RESOLVER_RESULT_KEYS);
  if (!fields || typeof fields.available !== 'boolean') fail('BANK_ACCOUNT_SOURCE_INVALID');
  const records = readArrayValues(fields.records, MAX_SOURCE_RECORDS);
  if (!records || (fields.available === false && records.length !== 0)) {
    fail('BANK_ACCOUNT_SOURCE_INVALID');
  }
  return Object.freeze({
    available: fields.available,
    records: Object.freeze(records.map(recordValidator))
  });
}

function unavailableResolverEnvelope() {
  return Object.freeze({ available: false, records: Object.freeze([]) });
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, character => character.codePointAt(0));
  const rightPoints = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function compareHandles(left, right) {
  const labelComparison = compareCodePoints(left.internalLabelOrder, right.internalLabelOrder);
  if (labelComparison !== 0) return labelComparison;
  if (left.bankAccountId === right.bankAccountId) return 0;
  return left.bankAccountId < right.bankAccountId ? -1 : 1;
}

function validateHandle(value) {
  const fields = readClosedFields(value, HANDLE_KEYS);
  if (!fields
    || typeof fields.bankAccountId !== 'string'
    || !UUID_PATTERN.test(fields.bankAccountId)
    || !isDisplayText(fields.internalLabelOrder)
    || !isReferenceId(fields.sourceRevision)) fail('BANK_ACCOUNT_SOURCE_INVALID');
  return Object.freeze({
    bankAccountId: fields.bankAccountId,
    internalLabelOrder: fields.internalLabelOrder,
    sourceRevision: fields.sourceRevision
  });
}

function validateSourceListResult(value, query) {
  const fields = readClosedFields(value, SOURCE_LIST_RESULT_KEYS);
  if (!fields || typeof fields.available !== 'boolean') fail('BANK_ACCOUNT_SOURCE_INVALID');
  if (fields.available === false) {
    const unavailableRecords = readArrayValues(fields.records, 0);
    if (fields.listRevision !== null || !unavailableRecords || fields.hasMore !== false) {
      fail('BANK_ACCOUNT_SOURCE_INVALID');
    }
    return null;
  }
  if (!isReferenceId(fields.listRevision) || typeof fields.hasMore !== 'boolean') {
    fail('BANK_ACCOUNT_SOURCE_INVALID');
  }
  const rawRecords = readArrayValues(fields.records, query.candidateLimit);
  if (!rawRecords) fail('BANK_ACCOUNT_SOURCE_INVALID');
  const records = rawRecords.map(validateHandle);
  const ids = new Set();
  for (let index = 0; index < records.length; index += 1) {
    if (ids.has(records[index].bankAccountId)
      || (index > 0 && compareHandles(records[index - 1], records[index]) >= 0)) {
      fail('BANK_ACCOUNT_SOURCE_INVALID');
    }
    ids.add(records[index].bankAccountId);
  }
  if ((fields.hasMore && records.length !== query.candidateLimit)
    || (!fields.hasMore && records.length === query.candidateLimit)) {
    fail('BANK_ACCOUNT_SOURCE_INVALID');
  }
  if (query.after !== null) {
    if (query.after.listRevision !== fields.listRevision
      || (records.length > 0 && compareHandles(records[0], query.after) <= 0)) {
      fail('BANK_ACCOUNT_SOURCE_INVALID');
    }
  }
  return Object.freeze({
    listRevision: fields.listRevision,
    records: Object.freeze(records),
    hasMore: fields.hasMore
  });
}

function sameFilters(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

function validateProvenTotal(value, query) {
  if (value === null) return null;
  const fields = readClosedFields(value, PROVEN_TOTAL_KEYS);
  const filters = fields ? readClosedFields(fields.filters, FILTER_KEYS, []) : null;
  if (!fields
    || fields.tenantId !== query.tenantId
    || fields.actorId !== query.actorId
    || !filters
    || !sameFilters(filters, query.filters)
    || fields.listRevision !== query.listRevision
    || !isReferenceId(fields.sourceRevision)
    || fields.scope !== TOTAL_SCOPE
    || !Number.isSafeInteger(fields.count)
    || fields.count < 0) return null;
  return Object.freeze({
    tenantId: fields.tenantId,
    actorId: fields.actorId,
    filters: copyAndFreeze(filters),
    listRevision: fields.listRevision,
    sourceRevision: fields.sourceRevision,
    scope: TOTAL_SCOPE,
    count: fields.count
  });
}

async function resolveTotal(totalSource, query) {
  let result;
  try {
    result = await totalSource(query);
  } catch (_error) {
    return null;
  }
  const fields = readClosedFields(result, TOTAL_RESULT_KEYS);
  if (!fields || typeof fields.available !== 'boolean') return null;
  if (fields.available === false) return null;
  return validateProvenTotal(fields.provenTotal, query);
}

function unavailableListEnvelope() {
  return Object.freeze({
    available: false,
    listRevision: UNAVAILABLE_REVISION,
    records: Object.freeze([]),
    hasMore: false,
    provenTotal: null
  });
}

function createMaskedBankAccountSourcePorts(options) {
  const factory = validateFactory(options);
  const sourceAvailable = inspectProbe(factory.sourceProbe);

  async function resolveAccount(input) {
    const query = validateAccountQuery(input);
    if (!sourceAvailable) return unavailableResolverEnvelope();
    const result = await invoke(factory.accountSource, query);
    return validateResolverEnvelope(result, validateAccountRecord);
  }

  function relationResolver(source, institution = false) {
    return async input => {
      const query = validateRelationQuery(input);
      if (!sourceAvailable) return unavailableResolverEnvelope();
      const result = await invoke(source, query);
      return validateResolverEnvelope(
        result,
        value => validateRelationRecord(value, institution)
      );
    };
  }

  const resolveEntity = relationResolver(factory.relationSources.entity);
  const resolveInstitution = relationResolver(factory.relationSources.institution, true);
  const resolveAgent = relationResolver(factory.relationSources.agent);

  async function listAccountHandles(input) {
    const query = validateListQuery(input);
    if (!sourceAvailable) return unavailableListEnvelope();
    const result = await invoke(factory.listSource, query);
    const list = validateSourceListResult(result, query);
    if (list === null) return unavailableListEnvelope();
    const totalQuery = Object.freeze({
      tenantId: query.tenantId,
      actorId: query.actorId,
      operation: READ_OPERATION,
      requestAt: query.requestAt,
      filters: query.filters,
      listRevision: list.listRevision
    });
    const provenTotal = await resolveTotal(factory.totalSource, totalQuery);
    return Object.freeze({
      available: true,
      listRevision: list.listRevision,
      records: list.records,
      hasMore: list.hasMore,
      provenTotal
    });
  }

  return Object.freeze({
    resolveAccount,
    resolveEntity,
    resolveInstitution,
    resolveAgent,
    listAccountHandles
  });
}

module.exports = {
  BankAccountSourceError,
  CONTRACT_VERSION,
  DATA_CLASSIFICATION,
  ENVIRONMENT_CLASS,
  MAX_CANDIDATE_HANDLES,
  MAX_SOURCE_RECORDS,
  SOURCE_CAPABILITIES,
  TOTAL_SCOPE,
  createMaskedBankAccountSourcePorts
};

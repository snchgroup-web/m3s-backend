'use strict';

const { types: { isProxy } } = require('node:util');
const {
  ACCOUNT_CLASSIFICATIONS,
  INSTITUTION_TYPES,
  projectBankAccountSummaryV1,
  validateBankAccountSummaryV1
} = require('./bankAccountContracts');

const READ_OPERATION = 'READ';
const REQUIRED_PERMISSION = 'finance:read';
const REQUIRED_CAPABILITY = 'bank-account:read-masked';
const MAX_RESOLVER_CALLS = 4;
const MAX_CONTEXT_VALUES = 64;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCESS_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const REQUEST_KEYS = Object.freeze(['bankAccountId', 'context']);
const CONTEXT_KEYS = Object.freeze([
  'tenantId', 'actorId', 'operation', 'requestAt', 'permissions', 'capabilities'
]);
const ACCOUNT_ENVELOPE_KEYS = Object.freeze(['summary', 'visible']);
const RESOLVER_RESULT_KEYS = Object.freeze(['available', 'records']);
const RELATION_KEYS = Object.freeze([
  'id', 'tenantId', 'labelSnapshot', 'sourceRevision', 'active', 'visible',
  'classification', 'effectiveFrom', 'effectiveTo'
]);
const INSTITUTION_RELATION_KEYS = Object.freeze([
  ...RELATION_KEYS, 'countryId', 'institutionType'
]);

class BankAccountReferenceError extends Error {
  constructor(code) {
    super('Bank account request could not be completed');
    Object.defineProperties(this, {
      name: { value: 'BankAccountReferenceError', configurable: true },
      code: { value: code, enumerable: true }
    });
  }
}

const fail = code => { throw new BankAccountReferenceError(code); };

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readExactDataFields(value, keys) {
  if (!isPlainRecord(value)) return null;
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (_error) {
    return null;
  }
  if (ownKeys.length !== keys.length
    || !ownKeys.every(key => typeof key === 'string' && keys.includes(key))) return null;

  const fields = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
    Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true });
  }
  return fields;
}

function readFactoryFields(options) {
  if (!isPlainRecord(options)) fail('BANK_ACCOUNT_REQUEST_INVALID');
  const allowed = [
    'accountResolver', 'entityResolver', 'institutionResolver', 'agentResolver',
    'canReadRestricted'
  ];
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(options);
  } catch (_error) {
    fail('BANK_ACCOUNT_REQUEST_INVALID');
  }
  if (!ownKeys.every(key => typeof key === 'string' && allowed.includes(key))) {
    fail('BANK_ACCOUNT_REQUEST_INVALID');
  }

  const fields = Object.create(null);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail('BANK_ACCOUNT_REQUEST_INVALID');
    }
    Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true });
  }
  return fields;
}

function isReferenceId(value) {
  return typeof value === 'string' && REFERENCE_ID_PATTERN.test(value);
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

function isIsoDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validateAccessSet(value) {
  if (!Array.isArray(value) || isProxy(value) || value.length > MAX_CONTEXT_VALUES) return null;
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
  if (Reflect.ownKeys(value).some(key => {
    if (key === 'length') return false;
    return typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length;
  })) return null;
  return Object.freeze(copy);
}

function validateRequest(input) {
  const request = readExactDataFields(input, REQUEST_KEYS);
  if (!request || typeof request.bankAccountId !== 'string'
    || !UUID_PATTERN.test(request.bankAccountId)) fail('BANK_ACCOUNT_REQUEST_INVALID');

  const context = readExactDataFields(request.context, CONTEXT_KEYS);
  if (!context || !isReferenceId(context.tenantId) || !isReferenceId(context.actorId)
    || context.operation !== READ_OPERATION || !isCanonicalInstant(context.requestAt)) {
    fail('BANK_ACCOUNT_REQUEST_INVALID');
  }
  const permissions = validateAccessSet(context.permissions);
  const capabilities = validateAccessSet(context.capabilities);
  if (!permissions || !capabilities) fail('BANK_ACCOUNT_REQUEST_INVALID');

  return Object.freeze({
    bankAccountId: request.bankAccountId,
    context: Object.freeze({
      tenantId: context.tenantId,
      actorId: context.actorId,
      operation: READ_OPERATION,
      requestAt: context.requestAt,
      permissions,
      capabilities
    })
  });
}

function frozenQuery(fields) {
  return Object.freeze({ ...fields });
}

function validateResolverResult(result) {
  const fields = readExactDataFields(result, RESOLVER_RESULT_KEYS);
  if (!fields || typeof fields.available !== 'boolean') {
    fail('BANK_ACCOUNT_REFERENCE_INVALID');
  }
  if (fields.available === false) fail('BANK_ACCOUNT_REFERENCE_UNAVAILABLE');
  if (!Array.isArray(fields.records) || isProxy(fields.records)) {
    fail('BANK_ACCOUNT_REFERENCE_INVALID');
  }
  return fields.records;
}

async function callResolver(resolver, query, callState) {
  if (callState.count >= MAX_RESOLVER_CALLS) fail('BANK_ACCOUNT_REFERENCE_INVALID');
  callState.count += 1;
  let result;
  try {
    result = await resolver(query);
  } catch (_error) {
    fail('BANK_ACCOUNT_REFERENCE_UNAVAILABLE');
  }
  return validateResolverResult(result);
}

function exactOne(records, zeroCode) {
  if (records.length === 0) fail(zeroCode);
  if (records.length !== 1) fail('BANK_ACCOUNT_REFERENCE_INVALID');
  const descriptor = Object.getOwnPropertyDescriptor(records, '0');
  if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    fail('BANK_ACCOUNT_REFERENCE_INVALID');
  }
  return descriptor.value;
}

function requestDate(requestAt) {
  return requestAt.slice(0, 10);
}

function isEffectiveAt(effectiveFrom, effectiveTo, date) {
  return (effectiveFrom === null || (isIsoDate(effectiveFrom) && effectiveFrom <= date))
    && (effectiveTo === null || (isIsoDate(effectiveTo) && date <= effectiveTo));
}

function validateAccountEnvelope(value) {
  const envelope = readExactDataFields(value, ACCOUNT_ENVELOPE_KEYS);
  if (!envelope || typeof envelope.visible !== 'boolean') {
    fail('BANK_ACCOUNT_REFERENCE_INVALID');
  }
  let summary;
  try {
    validateBankAccountSummaryV1(envelope.summary);
    summary = projectBankAccountSummaryV1(envelope.summary);
  } catch (_error) {
    fail('BANK_ACCOUNT_REFERENCE_INVALID');
  }
  return Object.freeze({ summary, visible: envelope.visible });
}

function relationMatchesSnapshot(record, snapshot, summary, date, isInstitution) {
  const keys = isInstitution ? INSTITUTION_RELATION_KEYS : RELATION_KEYS;
  const fields = readExactDataFields(record, keys);
  if (!fields
    || fields.id !== snapshot.id
    || fields.tenantId !== summary.tenantId
    || fields.labelSnapshot !== snapshot.labelSnapshot
    || fields.sourceRevision !== snapshot.sourceRevision
    || fields.active !== true
    || fields.visible !== true
    || !ACCOUNT_CLASSIFICATIONS.includes(fields.classification)
    || (summary.classification === 'C2' && fields.classification === 'C3')
    || !isEffectiveAt(fields.effectiveFrom, fields.effectiveTo, date)) return false;

  if (isInstitution && (fields.countryId !== snapshot.countryId
    || fields.institutionType !== snapshot.institutionType
    || !INSTITUTION_TYPES.includes(fields.institutionType))) return false;
  return true;
}

async function resolveRelation({
  resolver, snapshot, summary, date, context, callState, isInstitution = false
}) {
  const records = await callResolver(resolver, frozenQuery({
    id: snapshot.id,
    tenantId: context.tenantId,
    operation: context.operation,
    requestAt: context.requestAt,
    sourceRevision: snapshot.sourceRevision
  }), callState);
  const record = exactOne(records, 'BANK_ACCOUNT_RELATION_INVALID');
  if (!relationMatchesSnapshot(record, snapshot, summary, date, isInstitution)) {
    fail('BANK_ACCOUNT_RELATION_INVALID');
  }
}

function createBankAccountReferencePolicyService(options) {
  const fields = readFactoryFields(options);
  for (const name of [
    'accountResolver', 'entityResolver', 'institutionResolver', 'agentResolver'
  ]) {
    if (typeof fields[name] !== 'function') fail('BANK_ACCOUNT_REQUEST_INVALID');
  }
  if (Object.hasOwn(fields, 'canReadRestricted')
    && fields.canReadRestricted !== undefined
    && fields.canReadRestricted !== null
    && typeof fields.canReadRestricted !== 'function') fail('BANK_ACCOUNT_REQUEST_INVALID');

  async function resolveReadableBankAccountSummary(input) {
    const request = validateRequest(input);
    const { context } = request;
    if (!context.permissions.includes(REQUIRED_PERMISSION)
      || !context.capabilities.includes(REQUIRED_CAPABILITY)) {
      fail('BANK_ACCOUNT_ACCESS_DENIED');
    }

    const callState = { count: 0 };
    const accountRecords = await callResolver(fields.accountResolver, frozenQuery({
      bankAccountId: request.bankAccountId,
      tenantId: context.tenantId,
      operation: context.operation,
      requestAt: context.requestAt
    }), callState);
    const accountRecord = exactOne(accountRecords, 'BANK_ACCOUNT_ACCESS_DENIED');
    const account = validateAccountEnvelope(accountRecord);
    const { summary } = account;

    if (summary.bankAccountId !== request.bankAccountId
      || summary.tenantId !== context.tenantId
      || account.visible !== true) fail('BANK_ACCOUNT_ACCESS_DENIED');

    if (summary.classification === 'C3') {
      if (typeof fields.canReadRestricted !== 'function') fail('BANK_ACCOUNT_ACCESS_DENIED');
      let allowed;
      try {
        allowed = await fields.canReadRestricted(frozenQuery({
          tenantId: context.tenantId,
          actorId: context.actorId,
          bankAccountId: request.bankAccountId,
          classification: summary.classification,
          operation: context.operation,
          requestAt: context.requestAt
        }));
      } catch (_error) {
        fail('BANK_ACCOUNT_ACCESS_DENIED');
      }
      if (allowed !== true) fail('BANK_ACCOUNT_ACCESS_DENIED');
    }

    const date = requestDate(context.requestAt);
    if (summary.status !== 'active'
      || !isEffectiveAt(summary.effectiveFrom, summary.effectiveTo, date)) {
      fail('BANK_ACCOUNT_ACCESS_DENIED');
    }

    await resolveRelation({
      resolver: fields.entityResolver,
      snapshot: summary.holderEntity,
      summary,
      date,
      context,
      callState
    });
    await resolveRelation({
      resolver: fields.institutionResolver,
      snapshot: summary.financialInstitution,
      summary,
      date,
      context,
      callState,
      isInstitution: true
    });
    if (summary.businessOwnerAgent !== null) {
      await resolveRelation({
        resolver: fields.agentResolver,
        snapshot: summary.businessOwnerAgent,
        summary,
        date,
        context,
        callState
      });
    }

    return projectBankAccountSummaryV1(summary);
  }

  return Object.freeze({ resolveReadableBankAccountSummary });
}

module.exports = {
  BankAccountReferenceError,
  MAX_RESOLVER_CALLS,
  READ_OPERATION,
  REQUIRED_CAPABILITY,
  REQUIRED_PERMISSION,
  createBankAccountReferencePolicyService
};

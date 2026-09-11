const { types: { isProxy } } = require('node:util');

const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 120;
const MAX_MASKED_IDENTIFIER_LENGTH = 34;
const MAX_RECORD_VERSION = 1000000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MASKED_IDENTIFIER_PATTERN = /^\*{4,34}[A-Za-z0-9]{0,4}$/;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

// SIX ISO 4217 List One, published 2026-01-01.
const ISO_4217_PUBLICATION_DATE = '2026-01-01';
const ISO_4217_CODES = Object.freeze([
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV',
  'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD',
  'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP',
  'COU', 'CRC', 'CUP', 'CVE', 'CZK',
  'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP',
  'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HTG', 'HUF',
  'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
  'JMD', 'JOD', 'JPY',
  'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT',
  'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD',
  'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR',
  'MVR', 'MWK', 'MXN', 'MXV', 'MYR', 'MZN',
  'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD',
  'OMR',
  'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR',
  'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS',
  'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS',
  'VED', 'VES', 'VND', 'VUV',
  'WST',
  'XAD', 'XAF', 'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XCD',
  'XCG', 'XDR', 'XOF', 'XPD', 'XPF', 'XPT', 'XSU', 'XTS', 'XUA', 'XXX',
  'YER',
  'ZAR', 'ZMW', 'ZWG'
]);
const ISO_4217_CURRENCIES = new Set(ISO_4217_CODES);

const ACCOUNT_TYPES = Object.freeze([
  'OPERATING_CURRENT',
  'RESERVE_SAVINGS',
  'COLLECTION',
  'PROJECT_DEDICATED',
  'PAYMENT_ACCOUNT'
]);

const ACCOUNT_STATUSES = Object.freeze([
  'candidate',
  'verification_pending',
  'active',
  'suspended',
  'closed'
]);

const ACCOUNT_CLASSIFICATIONS = Object.freeze(['C2', 'C3']);

const INSTITUTION_TYPES = Object.freeze([
  'bank',
  'payment_institution',
  'other_regulated_institution'
]);

const SUMMARY_KEYS = Object.freeze([
  'bankAccountId',
  'tenantId',
  'holderEntity',
  'financialInstitution',
  'internalLabel',
  'accountType',
  'currency',
  'status',
  'maskedIdentifier',
  'classification',
  'businessOwnerAgent',
  'effectiveFrom',
  'effectiveTo',
  'sourceRevision',
  'verifiedAt',
  'recordVersion'
]);

const REFERENCE_KEYS = Object.freeze(['id', 'labelSnapshot', 'sourceRevision']);
const INSTITUTION_KEYS = Object.freeze([
  'id', 'labelSnapshot', 'countryId', 'institutionType', 'sourceRevision'
]);

class BankAccountContractError extends Error {
  constructor() {
    super('Invalid bank account summary contract');
    this.name = 'BankAccountContractError';
    this.code = 'BANK_ACCOUNT_REFERENCE_INVALID';
  }
}

const fail = () => { throw new BankAccountContractError(); };

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRequiredDataFields(value, keys) {
  if (!isPlainRecord(value)) return false;
  const fields = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return false;
    Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true });
  }
  return fields;
}

function hasRequiredDataFields(value, keys) {
  return Boolean(readRequiredDataFields(value, keys));
}

function hasExactFields(value, keys) {
  if (!hasRequiredDataFields(value, keys)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length
    && ownKeys.every(key => typeof key === 'string' && keys.includes(key));
}

function isReferenceId(value) {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH
    && REFERENCE_ID_PATTERN.test(value);
}

function isDisplayText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_LABEL_LENGTH
    && value === value.trim()
    && value.normalize('NFC') === value
    && !UNSAFE_TEXT_PATTERN.test(value);
}

function isIsoDate(value) {
  return typeof value === 'string'
    && DATE_PATTERN.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function isIsoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value.endsWith('.000Z')
    ? canonical === value
    : canonical.replace('.000Z', 'Z') === value;
}

function validateReferenceSnapshot(reference) {
  if (!hasExactFields(reference, REFERENCE_KEYS)
    || !isReferenceId(reference.id)
    || !isDisplayText(reference.labelSnapshot)
    || !isReferenceId(reference.sourceRevision)) fail();
}

function validateInstitutionSnapshot(institution) {
  if (!hasExactFields(institution, INSTITUTION_KEYS)
    || !isReferenceId(institution.id)
    || !isDisplayText(institution.labelSnapshot)
    || !isReferenceId(institution.countryId)
    || !INSTITUTION_TYPES.includes(institution.institutionType)
    || !isReferenceId(institution.sourceRevision)) fail();
}

function validateDates(summary) {
  if (summary.effectiveFrom !== null && !isIsoDate(summary.effectiveFrom)) fail();
  if (summary.effectiveTo !== null && !isIsoDate(summary.effectiveTo)) fail();
  if (summary.effectiveFrom !== null && summary.effectiveTo !== null
    && summary.effectiveTo < summary.effectiveFrom) fail();
  if (summary.verifiedAt !== null && !isIsoInstant(summary.verifiedAt)) fail();
  if (['candidate', 'verification_pending'].includes(summary.status)
    && summary.verifiedAt !== null) fail();
  if (['active', 'suspended', 'closed'].includes(summary.status)
    && summary.verifiedAt === null) fail();
}

function assertBankAccountSummaryV1(summary) {
  if (!hasExactFields(summary, SUMMARY_KEYS)
    || typeof summary.bankAccountId !== 'string'
    || !UUID_PATTERN.test(summary.bankAccountId)
    || !isReferenceId(summary.tenantId)
    || !isDisplayText(summary.internalLabel)
    || !ACCOUNT_TYPES.includes(summary.accountType)
    || typeof summary.currency !== 'string'
    || !CURRENCY_PATTERN.test(summary.currency)
    || !ISO_4217_CURRENCIES.has(summary.currency)
    || !ACCOUNT_STATUSES.includes(summary.status)
    || typeof summary.maskedIdentifier !== 'string'
    || summary.maskedIdentifier.length < 8
    || summary.maskedIdentifier.length > MAX_MASKED_IDENTIFIER_LENGTH
    || !MASKED_IDENTIFIER_PATTERN.test(summary.maskedIdentifier)
    || !ACCOUNT_CLASSIFICATIONS.includes(summary.classification)
    || !isReferenceId(summary.sourceRevision)
    || !Number.isInteger(summary.recordVersion)
    || summary.recordVersion < 1
    || summary.recordVersion > MAX_RECORD_VERSION) fail();

  validateReferenceSnapshot(summary.holderEntity);
  validateInstitutionSnapshot(summary.financialInstitution);
  if (summary.businessOwnerAgent !== null) {
    validateReferenceSnapshot(summary.businessOwnerAgent);
  }
  validateDates(summary);
  return summary;
}

function validateBankAccountSummaryV1(summary) {
  try {
    return assertBankAccountSummaryV1(summary);
  } catch (_error) {
    fail();
  }
}

function projectReferenceSnapshot(reference) {
  const fields = readRequiredDataFields(reference, REFERENCE_KEYS);
  if (!fields) fail();
  return {
    id: fields.id,
    labelSnapshot: fields.labelSnapshot,
    sourceRevision: fields.sourceRevision
  };
}

function projectInstitutionSnapshot(institution) {
  const fields = readRequiredDataFields(institution, INSTITUTION_KEYS);
  if (!fields) fail();
  return {
    id: fields.id,
    labelSnapshot: fields.labelSnapshot,
    countryId: fields.countryId,
    institutionType: fields.institutionType,
    sourceRevision: fields.sourceRevision
  };
}

function deepFreezeSummary(summary) {
  Object.freeze(summary.holderEntity);
  Object.freeze(summary.financialInstitution);
  if (summary.businessOwnerAgent !== null) Object.freeze(summary.businessOwnerAgent);
  return Object.freeze(summary);
}

function projectBankAccountSummaryV1(record) {
  let summary;
  try {
    const fields = readRequiredDataFields(record, SUMMARY_KEYS);
    if (!fields) fail();
    summary = {
      bankAccountId: fields.bankAccountId,
      tenantId: fields.tenantId,
      holderEntity: projectReferenceSnapshot(fields.holderEntity),
      financialInstitution: projectInstitutionSnapshot(fields.financialInstitution),
      internalLabel: fields.internalLabel,
      accountType: fields.accountType,
      currency: fields.currency,
      status: fields.status,
      maskedIdentifier: fields.maskedIdentifier,
      classification: fields.classification,
      businessOwnerAgent: fields.businessOwnerAgent === null
        ? null
        : projectReferenceSnapshot(fields.businessOwnerAgent),
      effectiveFrom: fields.effectiveFrom,
      effectiveTo: fields.effectiveTo,
      sourceRevision: fields.sourceRevision,
      verifiedAt: fields.verifiedAt,
      recordVersion: fields.recordVersion
    };
  } catch (_error) {
    fail();
  }
  validateBankAccountSummaryV1(summary);
  return deepFreezeSummary(summary);
}

module.exports = {
  ACCOUNT_CLASSIFICATIONS,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  BankAccountContractError,
  INSTITUTION_TYPES,
  ISO_4217_CODES,
  ISO_4217_PUBLICATION_DATE,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_MASKED_IDENTIFIER_LENGTH,
  MAX_RECORD_VERSION,
  projectBankAccountSummaryV1,
  validateBankAccountSummaryV1
};

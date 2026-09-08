const MAX_BYTES = 512 * 1024;
const MAX_VERSION = 1000000;
const MAX_ROWS = 100;
const PERIODS_PER_YEAR = 12;

const REFERENCE_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
const RATE_PATTERN = /^\d+(?:[.,]\d{1,6})?$/;

const BUDGET_KEYS = ['title', 'identity', 'responsibilities', 'rate', 'rateSource', 'rateDate', 'rows'];
const IDENTITY_KEYS = ['entityId', 'fiscalYearId'];
const RESPONSIBILITY_KEYS = ['budgetOwnerAgentId', 'controllerAgentId'];
const ROW_KEYS = ['id', 'label', 'kind', 'direction', 'currency', 'periodValues', 'dimensions'];
const PERIOD_VALUE_KEYS = ['periodId', 'value'];
const DIMENSION_KEYS = [
  'functionId', 'teamId', 'agentId', 'countryId',
  'portfolioId', 'dossierId', 'projectId', 'phaseId'
];

const KINDS = new Set(['operating', 'investment', 'financing']);
const DIRECTIONS = new Set(['in', 'out']);
const CURRENCIES = new Set(['CHF', 'CFA']);

class BudgetV2ContractError extends Error {
  constructor() {
    super('Invalid Budget V2 contract');
    this.name = 'BudgetV2ContractError';
    this.code = 'BUDGET_REQUEST_INVALID';
  }
}

const fail = () => { throw new BudgetV2ContractError(); };

function hasExactFields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function isText(value, max, required = false) {
  return typeof value === 'string' && value.length <= max
    && (!required || Boolean(value.trim()));
}

function isReferenceId(value) {
  return typeof value === 'string' && REFERENCE_ID_PATTERN.test(value)
    && Boolean(value.trim());
}

function isIsoDate(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function isBoundedDecimal(value, pattern, maximum) {
  if (typeof value !== 'string' || !pattern.test(value)) return false;
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) && number <= maximum;
}

function validateRate(budget) {
  const allEmpty = budget.rate === '' && budget.rateSource === '' && budget.rateDate === '';
  if (allEmpty) return;
  if (!isText(budget.rate, 24, true) || budget.rate !== budget.rate.trim()
    || !isBoundedDecimal(budget.rate, RATE_PATTERN, 1000000)
    || Number(budget.rate.replace(',', '.')) <= 0
    || !isText(budget.rateSource, 200, true) || budget.rateSource !== budget.rateSource.trim()
    || !isText(budget.rateDate, 10, true) || !isIsoDate(budget.rateDate)) fail();
}

function validateDimensions(dimensions) {
  if (!hasExactFields(dimensions, DIMENSION_KEYS)) fail();
  for (const key of DIMENSION_KEYS) {
    if (dimensions[key] !== null && !isReferenceId(dimensions[key])) fail();
  }
}

function validatePeriodValues(periodValues) {
  if (!Array.isArray(periodValues) || periodValues.length !== PERIODS_PER_YEAR) fail();
  const periodIds = new Set();
  for (const periodValue of periodValues) {
    if (!hasExactFields(periodValue, PERIOD_VALUE_KEYS)
      || !isReferenceId(periodValue.periodId) || periodIds.has(periodValue.periodId)
      || typeof periodValue.value !== 'string' || periodValue.value.length > 24
      || (periodValue.value !== ''
        && !isBoundedDecimal(periodValue.value, AMOUNT_PATTERN, 1000000000))) fail();
    periodIds.add(periodValue.periodId);
  }
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail();
  const rowIds = new Set();
  for (const row of rows) {
    if (!hasExactFields(row, ROW_KEYS)
      || !isText(row.id, 64, true) || rowIds.has(row.id)
      || !isText(row.label, 120, true)
      || !KINDS.has(row.kind) || !DIRECTIONS.has(row.direction)
      || !CURRENCIES.has(row.currency)) fail();
    validatePeriodValues(row.periodValues);
    validateDimensions(row.dimensions);
    rowIds.add(row.id);
  }
}

function validateBudgetV2(budget) {
  if (!hasExactFields(budget, BUDGET_KEYS)
    || !isText(budget.title, 120, true)
    || !hasExactFields(budget.identity, IDENTITY_KEYS)
    || !isReferenceId(budget.identity.entityId)
    || !isReferenceId(budget.identity.fiscalYearId)
    || !hasExactFields(budget.responsibilities, RESPONSIBILITY_KEYS)
    || !isReferenceId(budget.responsibilities.budgetOwnerAgentId)
    || (budget.responsibilities.controllerAgentId !== null
      && !isReferenceId(budget.responsibilities.controllerAgentId))) fail();
  validateRate(budget);
  validateRows(budget.rows);
  return budget;
}

function serializeValidBody(body, update) {
  const expectedKeys = update
    ? ['contractVersion', 'budget', 'expectedVersion']
    : ['contractVersion', 'budget'];
  if (!hasExactFields(body, expectedKeys) || body.contractVersion !== 2) fail();
  if (update && (!Number.isInteger(body.expectedVersion)
    || body.expectedVersion < 1 || body.expectedVersion >= MAX_VERSION)) fail();
  validateBudgetV2(body.budget);
  let json;
  try {
    json = JSON.stringify(body);
  } catch (_error) {
    fail();
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) fail();
  return json;
}

function validateBudgetV2CreateBody(body) {
  return serializeValidBody(body, false);
}

function validateBudgetV2UpdateBody(body) {
  return serializeValidBody(body, true);
}

module.exports = {
  BudgetV2ContractError,
  MAX_BYTES,
  MAX_ROWS,
  MAX_VERSION,
  PERIODS_PER_YEAR,
  validateBudgetV2,
  validateBudgetV2CreateBody,
  validateBudgetV2UpdateBody
};

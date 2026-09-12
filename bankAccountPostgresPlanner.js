'use strict';

const crypto = require('node:crypto');
const { types: { isProxy } } = require('node:util');
const {
  CONTRACT_ID: SCHEMA_CONTRACT_ID,
  MAX_POSTGRES_MAJOR,
  MIN_POSTGRES_MAJOR,
  SCHEMA_NAME,
  buildBankAccountPostgresOfflinePlan,
  validateBankAccountPostgresInspection,
  validateBankAccountPostgresOfflinePlan
} = require('./bankAccountPostgresSchema');

const CONTRACT_ID = 'M3S-CB-1-D-B-B-A-001';
const INVENTORY_CONTRACT_ID = 'M3S-CB-1-D-B-B-INV-001';
const PLAN_VERSION = 1;
const DATABASE_NAME = 'm3s_bank_accounts_ephemeral';
const INVENTORY_MAX_AGE_MS = 10 * 60 * 1000;
const PLAN_LIFETIME_MS = 30 * 60 * 1000;
const MAX_DATA_DEPTH = 64;
const MAX_DATA_NODES = 20000;
const TARGET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{4,95}$/;
const DISALLOWED_TARGET_TOKEN_PATTERN = /(?:^|[._/-])(?:prod(?:uction)?|preview|staging|stage|live|real|main|tenant|host|url|dsn|secret|token|password|key|connection)(?:$|[._/-])/i;
const UNEXPECTED_OBJECT_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const OUTCOMES = new Set(['blocked', 'planned-create', 'planned-noop']);

const TARGET_KEYS = Object.freeze([
  'targetRef', 'environment', 'engine', 'postgresMajor', 'databaseName',
  'schemaName', 'databaseEncoding', 'dataClassification'
]);
const INVENTORY_KEYS = Object.freeze([
  'targetRef', 'observedAt', 'inventoryContractId', 'environment', 'engine',
  'postgresMajor', 'databaseName', 'schemaName', 'databaseEncoding',
  'dataClassification', 'schemaState', 'catalog', 'catalogFingerprint',
  'unexpectedObjects'
]);
const PLAN_KEYS = Object.freeze([
  'contractId', 'planVersion', 'outcome', 'target', 'schemaPlanFingerprint',
  'inventoryFingerprint', 'statements', 'destructiveStatements',
  'requiresAuthorization', 'executionAuthorized', 'generatedAt', 'expiresAt',
  'fingerprint'
]);

class BankAccountPostgresPlannerError extends Error {
  constructor() {
    super('Invalid bank account PostgreSQL plan');
    Object.defineProperties(this, {
      name: { value: 'BankAccountPostgresPlannerError', configurable: true },
      code: { value: 'BANK_ACCOUNT_POSTGRES_PLAN_INVALID', enumerable: true }
    });
  }
}

const fail = () => { throw new BankAccountPostgresPlannerError(); };

function isPlainData(value) {
  const stack = [{ value, depth: 0, exit: false }];
  const active = new Set();
  let nodeCount = 0;

  while (stack.length > 0) {
    const item = stack.pop();
    const candidate = item.value;
    if (item.exit) {
      active.delete(candidate);
      continue;
    }
    if (candidate === null || ['string', 'boolean'].includes(typeof candidate)) continue;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || item.depth > MAX_DATA_DEPTH) return false;
    try {
      if (isProxy(candidate) || active.has(candidate)) return false;
    } catch (_error) {
      return false;
    }
    nodeCount += 1;
    if (nodeCount > MAX_DATA_NODES) return false;

    let prototype;
    let keys;
    try {
      prototype = Object.getPrototypeOf(candidate);
      keys = Reflect.ownKeys(candidate);
    } catch (_error) {
      return false;
    }
    if (prototype !== Object.prototype && prototype !== Array.prototype) return false;
    if (Array.isArray(candidate) && keys.length !== candidate.length + 1) return false;

    active.add(candidate);
    stack.push({ value: candidate, depth: item.depth, exit: true });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (typeof key !== 'string') return false;
      if (Array.isArray(candidate) && key === 'length') continue;
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      } catch (_error) {
        return false;
      }
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
      stack.push({ value: descriptor.value, depth: item.depth + 1, exit: false });
    }
  }
  return true;
}

function canonicalUnsafe(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalUnsafe).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalUnsafe(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonical(value) {
  if (!isPlainData(value)) fail();
  return canonicalUnsafe(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function clone(value) {
  if (!isPlainData(value)) fail();
  try {
    return structuredClone(value);
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

function exact(value, keys) {
  if (!isPlainData(value) || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function instant(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail();
  return parsed.getTime();
}

function validateSchemaPlan(schemaPlan) {
  try {
    validateBankAccountPostgresOfflinePlan(schemaPlan);
  } catch (_error) {
    fail();
  }
  const expected = buildBankAccountPostgresOfflinePlan();
  if (schemaPlan.contractId !== SCHEMA_CONTRACT_ID
    || canonical(schemaPlan) !== canonical(expected)) fail();
  return expected;
}

function validateTarget(target) {
  if (!exact(target, TARGET_KEYS) || !TARGET_REF_PATTERN.test(target.targetRef)
    || DISALLOWED_TARGET_TOKEN_PATTERN.test(target.targetRef)
    || target.environment !== 'local-ephemeral' || target.engine !== 'postgresql'
    || !Number.isInteger(target.postgresMajor)
    || target.postgresMajor < MIN_POSTGRES_MAJOR
    || target.postgresMajor > MAX_POSTGRES_MAJOR
    || target.databaseName !== DATABASE_NAME || target.schemaName !== SCHEMA_NAME
    || target.databaseEncoding !== 'UTF8'
    || target.dataClassification !== 'synthetic-masked-only') fail();
  return clone(target);
}

function validateUnexpectedObjects(values, mustBeEmpty) {
  if (!Array.isArray(values) || values.length > 20
    || values.some(value => typeof value !== 'string'
      || !UNEXPECTED_OBJECT_PATTERN.test(value))) fail();
  if (mustBeEmpty && values.length !== 0) fail();
}

function inventoryMatchesTarget(inventory, target) {
  return inventory.targetRef === target.targetRef
    && inventory.environment === target.environment
    && inventory.engine === target.engine
    && inventory.postgresMajor === target.postgresMajor
    && inventory.databaseName === target.databaseName
    && inventory.schemaName === target.schemaName
    && inventory.databaseEncoding === target.databaseEncoding
    && inventory.dataClassification === target.dataClassification;
}

function validateInventory(schemaPlan, target, inventory, generatedAtMs) {
  if (!exact(inventory, INVENTORY_KEYS)
    || inventory.inventoryContractId !== INVENTORY_CONTRACT_ID
    || !inventoryMatchesTarget(inventory, target)
    || !['missing', 'empty', 'conformant', 'divergent'].includes(inventory.schemaState)) fail();

  const observedAtMs = instant(inventory.observedAt);
  if (observedAtMs > generatedAtMs
    || generatedAtMs - observedAtMs > INVENTORY_MAX_AGE_MS) fail();

  if (inventory.schemaState === 'conformant') {
    validateUnexpectedObjects(inventory.unexpectedObjects, true);
    if (!inventory.catalog || typeof inventory.catalog !== 'object'
      || !/^[0-9a-f]{64}$/.test(inventory.catalogFingerprint || '')
      || fingerprint(inventory.catalog) !== inventory.catalogFingerprint) fail();
    try {
      validateBankAccountPostgresInspection(schemaPlan, {
        postgresMajor: inventory.postgresMajor,
        ...clone(inventory.catalog)
      });
    } catch (_error) {
      fail();
    }
  } else {
    if (inventory.catalog !== null || inventory.catalogFingerprint !== null) fail();
    validateUnexpectedObjects(
      inventory.unexpectedObjects,
      inventory.schemaState !== 'divergent'
    );
    if (inventory.schemaState === 'divergent'
      && inventory.unexpectedObjects.length === 0) fail();
  }

  return clone(inventory);
}

function outcomeFor(schemaState) {
  if (schemaState === 'empty') return 'planned-create';
  if (schemaState === 'conformant') return 'planned-noop';
  return 'blocked';
}

function buildBankAccountPostgresPlan({
  schemaPlan, target, inventory, generatedAt
} = {}) {
  const validatedSchemaPlan = validateSchemaPlan(schemaPlan);
  const validatedTarget = validateTarget(target);
  const generatedAtMs = instant(generatedAt);
  const validatedInventory = validateInventory(
    validatedSchemaPlan, validatedTarget, inventory, generatedAtMs
  );
  const outcome = outcomeFor(validatedInventory.schemaState);
  const unsignedPlan = {
    contractId: CONTRACT_ID,
    planVersion: PLAN_VERSION,
    outcome,
    target: validatedTarget,
    schemaPlanFingerprint: validatedSchemaPlan.fingerprint,
    inventoryFingerprint: fingerprint(validatedInventory),
    statements: outcome === 'planned-create'
      ? clone(validatedSchemaPlan.statements) : [],
    destructiveStatements: [],
    requiresAuthorization: outcome === 'planned-create',
    executionAuthorized: false,
    generatedAt,
    expiresAt: new Date(generatedAtMs + PLAN_LIFETIME_MS).toISOString()
  };
  return deepFreeze({ ...unsignedPlan, fingerprint: fingerprint(unsignedPlan) });
}

function validateBankAccountPostgresPlan(plan) {
  if (!exact(plan, PLAN_KEYS) || plan.contractId !== CONTRACT_ID
    || plan.planVersion !== PLAN_VERSION || !OUTCOMES.has(plan.outcome)
    || !/^[0-9a-f]{64}$/.test(plan.schemaPlanFingerprint || '')
    || !/^[0-9a-f]{64}$/.test(plan.inventoryFingerprint || '')
    || !Array.isArray(plan.statements) || !Array.isArray(plan.destructiveStatements)
    || plan.destructiveStatements.length !== 0 || plan.executionAuthorized !== false) fail();

  validateTarget(plan.target);
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  if (plan.schemaPlanFingerprint !== schemaPlan.fingerprint) fail();

  if (plan.outcome === 'planned-create') {
    if (plan.requiresAuthorization !== true
      || canonical(plan.statements) !== canonical(schemaPlan.statements)) fail();
  } else if (plan.requiresAuthorization !== false || plan.statements.length !== 0) fail();

  const generatedAtMs = instant(plan.generatedAt);
  const expiresAtMs = instant(plan.expiresAt);
  if (expiresAtMs - generatedAtMs !== PLAN_LIFETIME_MS) fail();

  const { fingerprint: suppliedFingerprint, ...unsignedPlan } = plan;
  if (fingerprint(unsignedPlan) !== suppliedFingerprint) fail();
  return deepFreeze({ valid: true, fingerprint: suppliedFingerprint });
}

module.exports = {
  BankAccountPostgresPlannerError,
  CONTRACT_ID,
  DATABASE_NAME,
  INVENTORY_CONTRACT_ID,
  INVENTORY_MAX_AGE_MS,
  PLAN_LIFETIME_MS,
  PLAN_VERSION,
  buildBankAccountPostgresPlan,
  validateBankAccountPostgresPlan
};


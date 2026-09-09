const crypto = require('node:crypto');
const {
  CONTRACT_ID: SCHEMA_CONTRACT_ID,
  MAX_POSTGRES_MAJOR,
  MIN_POSTGRES_MAJOR,
  SCHEMA_NAME,
  buildBudgetV2PostgresOfflinePlan,
  validateBudgetV2PostgresInspection
} = require('./financeBudgetV2PostgresSchema');

const CONTRACT_ID = 'BUDGET-T1-D-B-2-B-001';
const COLLECTOR_CONTRACT = 'BUDGET-T1-D-B-2-COL-001';
const PLAN_VERSION = 1;
const DATABASE_NAME = 'm3s_budget_v2_ephemeral';
const INVENTORY_MAX_AGE_MS = 10 * 60 * 1000;
const PLAN_LIFETIME_MS = 30 * 60 * 1000;
const TARGET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{4,95}$/;
const UNEXPECTED_OBJECT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const OUTCOMES = new Set(['blocked', 'planned-create', 'planned-noop']);

const TARGET_KEYS = Object.freeze([
  'targetRef', 'environment', 'engine', 'postgresMajor', 'databaseName',
  'schemaName', 'databaseEncoding', 'dataClassification'
]);
const INVENTORY_KEYS = Object.freeze([
  'targetRef', 'observedAt', 'collectorContract', 'databaseEncoding',
  'postgresMajor', 'schemaState', 'catalog', 'catalogFingerprint',
  'unexpectedObjects'
]);
const PLAN_KEYS = Object.freeze([
  'contractId', 'planVersion', 'outcome', 'target', 'schemaPlanFingerprint',
  'inventoryFingerprint', 'statements', 'destructiveStatements',
  'requiresAuthorization', 'rollbackMode', 'generatedAt', 'expiresAt',
  'fingerprint'
]);
const AUTHORIZATION_KEYS = Object.freeze([
  'decisionRef', 'planFingerprint', 'targetRef', 'confirmation',
  'authorizedAt', 'scope'
]);

class BudgetV2PostgresMigrationPlannerError extends Error {
  constructor() {
    super('Invalid Budget V2 PostgreSQL migration plan');
    this.name = 'BudgetV2PostgresMigrationPlannerError';
    this.code = 'BUDGET_V2_POSTGRES_MIGRATION_PLAN_INVALID';
  }
}

const fail = () => { throw new BudgetV2PostgresMigrationPlannerError(); };

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function canonical(value, seen = new WeakSet()) {
  if (value && typeof value === 'object') {
    if (seen.has(value)) fail();
    seen.add(value);
  }
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map(item => canonical(item, seen)).join(',')}]`;
  } else if (value && typeof value === 'object') {
    result = `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonical(value[key], seen)}`
    )).join(',')}}`;
  } else {
    result = JSON.stringify(value);
  }
  if (value && typeof value === 'object') seen.delete(value);
  return result;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function clone(value) {
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

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail();
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail();
  return parsed.getTime();
}

function validateSchemaPlan(schemaPlan) {
  const expected = buildBudgetV2PostgresOfflinePlan();
  if (!schemaPlan || schemaPlan.contractId !== SCHEMA_CONTRACT_ID
    || canonical(schemaPlan) !== canonical(expected)) fail();
  return expected;
}

function validateTarget(target) {
  if (!exact(target, TARGET_KEYS) || !TARGET_REF_PATTERN.test(target.targetRef)
    || target.environment !== 'local-ephemeral' || target.engine !== 'postgresql'
    || !Number.isInteger(target.postgresMajor)
    || target.postgresMajor < MIN_POSTGRES_MAJOR
    || target.postgresMajor > MAX_POSTGRES_MAJOR
    || target.databaseName !== DATABASE_NAME || target.schemaName !== SCHEMA_NAME
    || target.databaseEncoding !== 'UTF8'
    || target.dataClassification !== 'synthetic-only') fail();
  return clone(target);
}

function validateUnexpectedObjects(values, mustBeEmpty) {
  if (!Array.isArray(values) || values.length > 20
    || values.some(value => typeof value !== 'string'
      || !UNEXPECTED_OBJECT_PATTERN.test(value))) fail();
  if (mustBeEmpty && values.length !== 0) fail();
}

function validateInventory(schemaPlan, target, inventory, generatedAt) {
  if (!exact(inventory, INVENTORY_KEYS) || inventory.targetRef !== target.targetRef
    || inventory.collectorContract !== COLLECTOR_CONTRACT
    || inventory.databaseEncoding !== target.databaseEncoding
    || inventory.postgresMajor !== target.postgresMajor
    || !['missing', 'empty', 'conformant', 'divergent'].includes(inventory.schemaState)) {
    fail();
  }
  const observedAt = instant(inventory.observedAt);
  if (observedAt > generatedAt || generatedAt - observedAt > INVENTORY_MAX_AGE_MS) fail();

  if (inventory.schemaState === 'conformant') {
    validateUnexpectedObjects(inventory.unexpectedObjects, true);
    if (!inventory.catalog || typeof inventory.catalog !== 'object'
      || !/^[0-9a-f]{64}$/.test(inventory.catalogFingerprint || '')
      || fingerprint(inventory.catalog) !== inventory.catalogFingerprint) fail();
    try {
      validateBudgetV2PostgresInspection(schemaPlan, {
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

function buildBudgetV2PostgresMigrationPlan({
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
    rollbackMode: 'disable-only',
    generatedAt,
    expiresAt: new Date(generatedAtMs + PLAN_LIFETIME_MS).toISOString()
  };
  return deepFreeze({ ...unsignedPlan, fingerprint: fingerprint(unsignedPlan) });
}

function validatePlan(plan) {
  if (!exact(plan, PLAN_KEYS) || plan.contractId !== CONTRACT_ID
    || plan.planVersion !== PLAN_VERSION || !OUTCOMES.has(plan.outcome)
    || !/^[0-9a-f]{64}$/.test(plan.schemaPlanFingerprint || '')
    || !/^[0-9a-f]{64}$/.test(plan.inventoryFingerprint || '')
    || !Array.isArray(plan.statements) || !Array.isArray(plan.destructiveStatements)
    || plan.destructiveStatements.length !== 0 || plan.rollbackMode !== 'disable-only') fail();
  validateTarget(plan.target);
  const schemaPlan = buildBudgetV2PostgresOfflinePlan();
  if (plan.schemaPlanFingerprint !== schemaPlan.fingerprint) fail();
  if (plan.outcome === 'planned-create') {
    if (plan.requiresAuthorization !== true
      || canonical(plan.statements) !== canonical(schemaPlan.statements)) fail();
  } else if (plan.requiresAuthorization !== false || plan.statements.length !== 0) fail();
  const generatedAt = instant(plan.generatedAt);
  const expiresAt = instant(plan.expiresAt);
  if (expiresAt - generatedAt !== PLAN_LIFETIME_MS) fail();
  const { fingerprint: suppliedFingerprint, ...unsignedPlan } = plan;
  if (fingerprint(unsignedPlan) !== suppliedFingerprint) fail();
  return { generatedAt, expiresAt };
}

function validateBudgetV2PostgresMigrationAuthorization({
  plan, authorization, now
} = {}) {
  const times = validatePlan(plan);
  const nowMs = instant(now);
  if (plan.outcome !== 'planned-create' || nowMs < times.generatedAt
    || nowMs > times.expiresAt || !exact(authorization, AUTHORIZATION_KEYS)
    || !TARGET_REF_PATTERN.test(authorization.decisionRef)
    || authorization.planFingerprint !== plan.fingerprint
    || authorization.targetRef !== plan.target.targetRef
    || authorization.confirmation !== `APPLY BUDGET V2 DDL TO ${plan.target.targetRef} AT ${plan.fingerprint}`
    || authorization.scope !== 'apply-three-budget-v2-ddl-statements') fail();
  const authorizedAt = instant(authorization.authorizedAt);
  if (authorizedAt < times.generatedAt || authorizedAt > times.expiresAt
    || authorizedAt > nowMs) fail();
  return deepFreeze({
    authorized: true,
    decisionRef: authorization.decisionRef,
    planFingerprint: plan.fingerprint,
    targetRef: plan.target.targetRef,
    authorizedAt: authorization.authorizedAt,
    scope: authorization.scope
  });
}

module.exports = {
  BudgetV2PostgresMigrationPlannerError,
  COLLECTOR_CONTRACT,
  CONTRACT_ID,
  DATABASE_NAME,
  INVENTORY_MAX_AGE_MS,
  PLAN_LIFETIME_MS,
  buildBudgetV2PostgresMigrationPlan,
  validateBudgetV2PostgresMigrationAuthorization
};

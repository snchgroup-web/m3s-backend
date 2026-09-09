const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  COLLECTOR_CONTRACT,
  CONTRACT_ID,
  DATABASE_NAME,
  buildBudgetV2PostgresMigrationPlan,
  validateBudgetV2PostgresMigrationAuthorization
} = require('../financeBudgetV2PostgresMigrationPlanner');
const {
  SCHEMA_NAME,
  buildBudgetV2PostgresOfflinePlan
} = require('../financeBudgetV2PostgresSchema');

const GENERATED_AT = '2026-09-09T20:00:00.000Z';
const OBSERVED_AT = '2026-09-09T19:55:00.000Z';
const NOW = '2026-09-09T20:10:00.000Z';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function target(overrides = {}) {
  return {
    targetRef: 'local-budget-v2-001',
    environment: 'local-ephemeral',
    engine: 'postgresql',
    postgresMajor: 18,
    databaseName: DATABASE_NAME,
    schemaName: SCHEMA_NAME,
    databaseEncoding: 'UTF8',
    dataClassification: 'synthetic-only',
    ...overrides
  };
}

function inventory(schemaPlan, schemaState = 'empty', overrides = {}) {
  const catalog = schemaState === 'conformant'
    ? structuredClone(schemaPlan.expectedCatalog) : null;
  return {
    targetRef: 'local-budget-v2-001',
    observedAt: OBSERVED_AT,
    collectorContract: COLLECTOR_CONTRACT,
    databaseEncoding: 'UTF8',
    postgresMajor: 18,
    schemaState,
    catalog,
    catalogFingerprint: catalog ? fingerprint(catalog) : null,
    unexpectedObjects: schemaState === 'divergent' ? ['catalog-drift'] : [],
    ...overrides
  };
}

function build(schemaState = 'empty', overrides = {}) {
  const schemaPlan = overrides.schemaPlan || buildBudgetV2PostgresOfflinePlan();
  return buildBudgetV2PostgresMigrationPlan({
    schemaPlan,
    target: overrides.target || target(),
    inventory: overrides.inventory || inventory(schemaPlan, schemaState),
    generatedAt: overrides.generatedAt || GENERATED_AT
  });
}

function authorization(plan, overrides = {}) {
  return {
    decisionRef: 'BUDGET-T1-D-B-2-B-AUTH-001',
    planFingerprint: plan.fingerprint,
    targetRef: plan.target.targetRef,
    confirmation: `APPLY BUDGET V2 DDL TO ${plan.target.targetRef} AT ${plan.fingerprint}`,
    authorizedAt: '2026-09-09T20:05:00.000Z',
    scope: 'apply-three-budget-v2-ddl-statements',
    ...overrides
  };
}

function rejects(run) {
  assert.throws(run, error => error?.code === 'BUDGET_V2_POSTGRES_MIGRATION_PLAN_INVALID'
    && error.message === 'Invalid Budget V2 PostgreSQL migration plan');
}

test('empty attested schema produces one deterministic frozen create plan', () => {
  const first = build('empty');
  const second = build('empty');
  const schemaPlan = buildBudgetV2PostgresOfflinePlan();
  assert.equal(first.contractId, CONTRACT_ID);
  assert.equal(first.outcome, 'planned-create');
  assert.equal(first.requiresAuthorization, true);
  assert.deepEqual(first.statements, schemaPlan.statements);
  assert.deepEqual(first.destructiveStatements, []);
  assert.equal(first.rollbackMode, 'disable-only');
  assert.equal(first.expiresAt, '2026-09-09T20:30:00.000Z');
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.target), true);
  assert.equal(Object.isFrozen(first.statements), true);
});

test('missing and divergent schemas are blocked without instructions', () => {
  for (const schemaState of ['missing', 'divergent']) {
    const plan = build(schemaState);
    assert.equal(plan.outcome, 'blocked');
    assert.equal(plan.requiresAuthorization, false);
    assert.deepEqual(plan.statements, []);
    assert.deepEqual(plan.destructiveStatements, []);
  }
});

test('an exact conformant catalog produces an idempotent no-op', () => {
  const plan = build('conformant');
  assert.equal(plan.outcome, 'planned-noop');
  assert.equal(plan.requiresAuthorization, false);
  assert.deepEqual(plan.statements, []);
});

test('target contract refuses another environment, engine, schema or classification', () => {
  for (const overrides of [
    { targetRef: 'x' },
    { environment: 'production' },
    { engine: 'bigquery' },
    { postgresMajor: 15 },
    { postgresMajor: 19 },
    { databaseName: 'm3s' },
    { schemaName: 'public' },
    { databaseEncoding: 'LATIN1' },
    { dataClassification: 'real-data' },
    { host: 'localhost' }
  ]) rejects(() => build('empty', { target: target(overrides) }));
});

test('inventory must match the target and remain closed', () => {
  const schemaPlan = buildBudgetV2PostgresOfflinePlan();
  for (const overrides of [
    { targetRef: 'local-budget-v2-002' },
    { collectorContract: 'UNKNOWN' },
    { databaseEncoding: 'LATIN1' },
    { postgresMajor: 17 },
    { schemaState: 'unknown' },
    { secret: 'forbidden' }
  ]) rejects(() => buildBudgetV2PostgresMigrationPlan({
    schemaPlan,
    target: target(),
    inventory: inventory(schemaPlan, 'empty', overrides),
    generatedAt: GENERATED_AT
  }));
});

test('inventory freshness is bounded and future observations are refused', () => {
  const schemaPlan = buildBudgetV2PostgresOfflinePlan();
  const create = observedAt => () => buildBudgetV2PostgresMigrationPlan({
    schemaPlan,
    target: target(),
    inventory: inventory(schemaPlan, 'empty', { observedAt }),
    generatedAt: GENERATED_AT
  });
  assert.equal(create('2026-09-09T19:50:00.000Z')().outcome, 'planned-create');
  rejects(create('2026-09-09T19:49:59.999Z'));
  rejects(create('2026-09-09T20:00:00.001Z'));
  rejects(create('2026-09-09T19:55:00Z'));
});

test('catalog state, fingerprint and unexpected objects cannot contradict each other', () => {
  const schemaPlan = buildBudgetV2PostgresOfflinePlan();
  const malformed = [
    inventory(schemaPlan, 'empty', { catalog: {} }),
    inventory(schemaPlan, 'empty', { catalogFingerprint: '0'.repeat(64) }),
    inventory(schemaPlan, 'empty', { unexpectedObjects: ['table'] }),
    inventory(schemaPlan, 'divergent', { unexpectedObjects: [] }),
    inventory(schemaPlan, 'divergent', { unexpectedObjects: ['Bad Name'] }),
    inventory(schemaPlan, 'conformant', { catalogFingerprint: '0'.repeat(64) }),
    inventory(schemaPlan, 'conformant', { unexpectedObjects: ['extra-table'] })
  ];
  for (const candidate of malformed) rejects(() => buildBudgetV2PostgresMigrationPlan({
    schemaPlan,
    target: target(),
    inventory: candidate,
    generatedAt: GENERATED_AT
  }));
});

test('conformant catalog drift is refused instead of repaired', () => {
  const schemaPlan = buildBudgetV2PostgresOfflinePlan();
  const candidate = inventory(schemaPlan, 'conformant');
  candidate.catalog.tables[0].columns[0].nullable = true;
  candidate.catalogFingerprint = fingerprint(candidate.catalog);
  rejects(() => buildBudgetV2PostgresMigrationPlan({
    schemaPlan,
    target: target(),
    inventory: candidate,
    generatedAt: GENERATED_AT
  }));
});

test('cyclic catalog input is refused with the planner error boundary', () => {
  const schemaPlan = buildBudgetV2PostgresOfflinePlan();
  const candidate = inventory(schemaPlan, 'conformant');
  candidate.catalog.loop = candidate.catalog;
  candidate.catalogFingerprint = '0'.repeat(64);
  rejects(() => buildBudgetV2PostgresMigrationPlan({
    schemaPlan,
    target: target(),
    inventory: candidate,
    generatedAt: GENERATED_AT
  }));
});

test('schema plan alteration is refused before a migration plan is emitted', () => {
  for (const change of [
    value => { value.fingerprint = '0'.repeat(64); },
    value => { value.statements[0] += '; DROP TABLE x'; },
    value => { value.applyMode = 'execute'; }
  ]) {
    const schemaPlan = structuredClone(buildBudgetV2PostgresOfflinePlan());
    change(schemaPlan);
    rejects(() => build('empty', { schemaPlan }));
  }
});

test('authorization validates the exact live create plan and returns a frozen attestation', () => {
  const plan = build('empty');
  assert.deepEqual(validateBudgetV2PostgresMigrationAuthorization({
    plan, authorization: authorization(plan), now: NOW
  }), {
    authorized: true,
    decisionRef: 'BUDGET-T1-D-B-2-B-AUTH-001',
    planFingerprint: plan.fingerprint,
    targetRef: plan.target.targetRef,
    authorizedAt: '2026-09-09T20:05:00.000Z',
    scope: 'apply-three-budget-v2-ddl-statements'
  });
  assert.equal(Object.isFrozen(validateBudgetV2PostgresMigrationAuthorization({
    plan, authorization: authorization(plan), now: NOW
  })), true);
});

test('authorization refuses blocked, no-op, altered and expired plans', () => {
  for (const plan of [build('missing'), build('conformant')]) {
    rejects(() => validateBudgetV2PostgresMigrationAuthorization({
      plan, authorization: authorization(plan), now: NOW
    }));
  }
  const createPlan = build('empty');
  for (const change of [
    value => { value.fingerprint = '0'.repeat(64); },
    value => { value.statements = []; },
    value => { value.outcome = 'planned-noop'; },
    value => { value.unexpected = true; }
  ]) {
    const altered = structuredClone(createPlan);
    change(altered);
    rejects(() => validateBudgetV2PostgresMigrationAuthorization({
      plan: altered, authorization: authorization(createPlan), now: NOW
    }));
  }
  rejects(() => validateBudgetV2PostgresMigrationAuthorization({
    plan: createPlan,
    authorization: authorization(createPlan),
    now: '2026-09-09T20:30:00.001Z'
  }));
});

test('authorization fields, target, confirmation, scope and timing are exact', () => {
  const plan = build('empty');
  for (const overrides of [
    { decisionRef: 'x' },
    { planFingerprint: '0'.repeat(64) },
    { targetRef: 'local-budget-v2-002' },
    { confirmation: 'APPLY' },
    { authorizedAt: '2026-09-09T19:59:59.999Z' },
    { authorizedAt: '2026-09-09T20:10:00.001Z' },
    { scope: 'apply-all' },
    { secret: 'forbidden' }
  ]) rejects(() => validateBudgetV2PostgresMigrationAuthorization({
    plan,
    authorization: authorization(plan, overrides),
    now: NOW
  }));
  rejects(() => validateBudgetV2PostgresMigrationAuthorization({
    plan, authorization: authorization(plan), now: '2026-09-09T19:59:59.999Z'
  }));
});

test('all accepted changes alter the bound plan fingerprint', () => {
  const baseline = build('empty');
  const laterInventory = buildBudgetV2PostgresOfflinePlan();
  const changed = buildBudgetV2PostgresMigrationPlan({
    schemaPlan: laterInventory,
    target: target(),
    inventory: inventory(laterInventory, 'empty', {
      observedAt: '2026-09-09T19:56:00.000Z'
    }),
    generatedAt: GENERATED_AT
  });
  assert.notEqual(changed.inventoryFingerprint, baseline.inventoryFingerprint);
  assert.notEqual(changed.fingerprint, baseline.fingerprint);
  assert.notEqual(build('empty', {
    generatedAt: '2026-09-09T20:01:00.000Z'
  }).fingerprint, baseline.fingerprint);
});

test('pure planner has no driver, route, environment, I/O or execution dependency', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'financeBudgetV2PostgresMigrationPlanner.js'
  ), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const migrations = fs.readFileSync(path.join(__dirname, '..', 'schemaMigrations.js'), 'utf8');
  assert.doesNotMatch(source,
    /express|@google-cloud|@electric-sql|require\(['"]pg['"]\)|process\.env|Date\.now|node:fs|node:http|node:https|\.query\(|\.connect\(|\.exec\(/i);
  assert.doesNotMatch(server, /financeBudgetV2PostgresMigrationPlanner/);
  assert.doesNotMatch(migrations, /financeBudgetV2PostgresMigrationPlanner/);
});

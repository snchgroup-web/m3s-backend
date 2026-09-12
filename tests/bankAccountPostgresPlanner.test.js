'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONTRACT_ID,
  DATABASE_NAME,
  INVENTORY_CONTRACT_ID,
  buildBankAccountPostgresPlan,
  validateBankAccountPostgresPlan
} = require('../bankAccountPostgresPlanner');
const {
  MAX_POSTGRES_MAJOR,
  MIN_POSTGRES_MAJOR,
  SCHEMA_NAME,
  buildBankAccountPostgresOfflinePlan
} = require('../bankAccountPostgresSchema');

const GENERATED_AT = '2026-09-12T15:00:00.000Z';
const OBSERVED_AT = '2026-09-12T14:55:00.000Z';

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
    targetRef: 'local-bank-accounts-ephemeral-001',
    environment: 'local-ephemeral',
    engine: 'postgresql',
    postgresMajor: 18,
    databaseName: DATABASE_NAME,
    schemaName: SCHEMA_NAME,
    databaseEncoding: 'UTF8',
    dataClassification: 'synthetic-masked-only',
    ...overrides
  };
}

function inventory(schemaPlan, schemaState = 'empty', overrides = {}) {
  const catalog = schemaState === 'conformant'
    ? structuredClone(schemaPlan.expectedCatalog) : null;
  return {
    targetRef: 'local-bank-accounts-ephemeral-001',
    observedAt: OBSERVED_AT,
    inventoryContractId: INVENTORY_CONTRACT_ID,
    environment: 'local-ephemeral',
    engine: 'postgresql',
    postgresMajor: 18,
    databaseName: DATABASE_NAME,
    schemaName: SCHEMA_NAME,
    databaseEncoding: 'UTF8',
    dataClassification: 'synthetic-masked-only',
    schemaState,
    catalog,
    catalogFingerprint: catalog ? fingerprint(catalog) : null,
    unexpectedObjects: schemaState === 'divergent' ? ['catalog_drift'] : [],
    ...overrides
  };
}

function build(schemaState = 'empty', overrides = {}) {
  const schemaPlan = Object.hasOwn(overrides, 'schemaPlan')
    ? overrides.schemaPlan : buildBankAccountPostgresOfflinePlan();
  return buildBankAccountPostgresPlan({
    schemaPlan,
    target: Object.hasOwn(overrides, 'target') ? overrides.target : target(),
    inventory: Object.hasOwn(overrides, 'inventory')
      ? overrides.inventory : inventory(schemaPlan, schemaState),
    generatedAt: Object.hasOwn(overrides, 'generatedAt')
      ? overrides.generatedAt : GENERATED_AT
  });
}

function rejects(run) {
  assert.throws(run, error => error?.code === 'BANK_ACCOUNT_POSTGRES_PLAN_INVALID'
    && error.message === 'Invalid bank account PostgreSQL plan');
}

test('empty synthetic inventory produces a deterministic frozen create plan', () => {
  const first = build('empty');
  const second = build('empty');
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  assert.equal(first.contractId, CONTRACT_ID);
  assert.equal(first.outcome, 'planned-create');
  assert.equal(first.requiresAuthorization, true);
  assert.equal(first.executionAuthorized, false);
  assert.deepEqual(first.statements, schemaPlan.statements);
  assert.deepEqual(first.destructiveStatements, []);
  assert.equal(first.expiresAt, '2026-09-12T15:30:00.000Z');
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.target), true);
  assert.equal(Object.isFrozen(first.statements), true);
});

test('missing and divergent inventories are blocked without instructions', () => {
  for (const schemaState of ['missing', 'divergent']) {
    const plan = build(schemaState);
    assert.equal(plan.outcome, 'blocked');
    assert.equal(plan.requiresAuthorization, false);
    assert.equal(plan.executionAuthorized, false);
    assert.deepEqual(plan.statements, []);
    assert.deepEqual(plan.destructiveStatements, []);
  }
});

test('an exact conformant catalog produces a no-op', () => {
  const plan = build('conformant');
  assert.equal(plan.outcome, 'planned-noop');
  assert.equal(plan.requiresAuthorization, false);
  assert.equal(plan.executionAuthorized, false);
  assert.deepEqual(plan.statements, []);
});

test('target is local ephemeral synthetic and exact', () => {
  for (const overrides of [
    { targetRef: 'x' },
    { targetRef: 'production-bank-001' },
    { targetRef: 'local-preview-bank-001' },
    { targetRef: 'local-secret-bank-001' },
    { environment: 'production' },
    { engine: 'bigquery' },
    { postgresMajor: MIN_POSTGRES_MAJOR - 1 },
    { postgresMajor: MAX_POSTGRES_MAJOR + 1 },
    { databaseName: 'm3s' },
    { schemaName: 'public' },
    { databaseEncoding: 'LATIN1' },
    { dataClassification: 'real-data' },
    { host: 'localhost' }
  ]) rejects(() => build('empty', { target: target(overrides) }));
});

test('inventory identity and target metadata must match exactly', () => {
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  for (const overrides of [
    { targetRef: 'local-bank-accounts-ephemeral-002' },
    { inventoryContractId: 'UNKNOWN' },
    { environment: 'test' },
    { engine: 'other' },
    { postgresMajor: 17 },
    { databaseName: 'other' },
    { schemaName: 'other' },
    { databaseEncoding: 'LATIN1' },
    { dataClassification: 'synthetic-only' },
    { schemaState: 'unknown' },
    { secret: 'forbidden' }
  ]) rejects(() => buildBankAccountPostgresPlan({
    schemaPlan,
    target: target(),
    inventory: inventory(schemaPlan, 'empty', overrides),
    generatedAt: GENERATED_AT
  }));
});

test('inventory age is at most ten minutes and future observations are refused', () => {
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  const create = observedAt => () => buildBankAccountPostgresPlan({
    schemaPlan,
    target: target(),
    inventory: inventory(schemaPlan, 'empty', { observedAt }),
    generatedAt: GENERATED_AT
  });
  assert.equal(create('2026-09-12T14:50:00.000Z')().outcome, 'planned-create');
  rejects(create('2026-09-12T14:49:59.999Z'));
  rejects(create('2026-09-12T15:00:00.001Z'));
  rejects(create('2026-09-12T14:55:00Z'));
});

test('inventory states keep catalog and unexpected objects coherent', () => {
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  const malformed = [
    inventory(schemaPlan, 'empty', { catalog: {} }),
    inventory(schemaPlan, 'empty', { catalogFingerprint: '0'.repeat(64) }),
    inventory(schemaPlan, 'empty', { unexpectedObjects: ['table'] }),
    inventory(schemaPlan, 'missing', { unexpectedObjects: ['table'] }),
    inventory(schemaPlan, 'divergent', { unexpectedObjects: [] }),
    inventory(schemaPlan, 'divergent', { unexpectedObjects: ['Bad-Name'] }),
    inventory(schemaPlan, 'conformant', { catalogFingerprint: '0'.repeat(64) }),
    inventory(schemaPlan, 'conformant', { unexpectedObjects: ['extra_table'] })
  ];
  for (const candidate of malformed) rejects(() => buildBankAccountPostgresPlan({
    schemaPlan,
    target: target(),
    inventory: candidate,
    generatedAt: GENERATED_AT
  }));
});

test('conformant catalog drift is refused instead of repaired', () => {
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  const candidate = inventory(schemaPlan, 'conformant');
  candidate.catalog.tables[0].columns[0].nullable = true;
  candidate.catalogFingerprint = fingerprint(candidate.catalog);
  rejects(() => buildBankAccountPostgresPlan({
    schemaPlan,
    target: target(),
    inventory: candidate,
    generatedAt: GENERATED_AT
  }));
});

test('schema plan alterations are refused before output', () => {
  for (const change of [
    value => { value.fingerprint = '0'.repeat(64); },
    value => { value.statements[0] += '; DROP TABLE x'; },
    value => { value.applyMode = 'execute'; },
    value => { value.contractId = 'OTHER'; }
  ]) {
    const schemaPlan = structuredClone(buildBankAccountPostgresOfflinePlan());
    change(schemaPlan);
    rejects(() => build('empty', { schemaPlan }));
  }
});

test('validator accepts emitted plans and returns a frozen attestation', () => {
  for (const schemaState of ['missing', 'empty', 'conformant', 'divergent']) {
    const plan = build(schemaState);
    assert.deepEqual(validateBankAccountPostgresPlan(plan), {
      valid: true,
      fingerprint: plan.fingerprint
    });
    assert.equal(Object.isFrozen(validateBankAccountPostgresPlan(plan)), true);
  }
});

test('validator rejects altered plans and additional properties', () => {
  const baseline = build('empty');
  for (const change of [
    value => { value.fingerprint = '0'.repeat(64); },
    value => { value.statements = []; },
    value => { value.outcome = 'planned-noop'; },
    value => { value.executionAuthorized = true; },
    value => { value.destructiveStatements = ['DROP SCHEMA']; },
    value => { value.expiresAt = '2026-09-12T15:30:00.001Z'; },
    value => { value.unexpected = true; }
  ]) {
    const altered = structuredClone(baseline);
    change(altered);
    rejects(() => validateBankAccountPostgresPlan(altered));
  }
});

test('accepted inventory and time changes alter bound fingerprints', () => {
  const baseline = build('empty');
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  const changedInventory = buildBankAccountPostgresPlan({
    schemaPlan,
    target: target(),
    inventory: inventory(schemaPlan, 'empty', {
      observedAt: '2026-09-12T14:56:00.000Z'
    }),
    generatedAt: GENERATED_AT
  });
  assert.notEqual(changedInventory.inventoryFingerprint, baseline.inventoryFingerprint);
  assert.notEqual(changedInventory.fingerprint, baseline.fingerprint);
  assert.notEqual(build('empty', {
    generatedAt: '2026-09-12T15:01:00.000Z'
  }).fingerprint, baseline.fingerprint);
});

test('all supported PostgreSQL major versions remain explicit', () => {
  for (let postgresMajor = MIN_POSTGRES_MAJOR;
    postgresMajor <= MAX_POSTGRES_MAJOR; postgresMajor += 1) {
    const schemaPlan = buildBankAccountPostgresOfflinePlan();
    const plan = buildBankAccountPostgresPlan({
      schemaPlan,
      target: target({ postgresMajor }),
      inventory: inventory(schemaPlan, 'empty', { postgresMajor }),
      generatedAt: GENERATED_AT
    });
    assert.equal(plan.target.postgresMajor, postgresMajor);
  }
});

test('unexpected object inventory is bounded and uses PostgreSQL-safe names', () => {
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  const accepted = Array.from({ length: 20 }, (_, index) => `unexpected_${index}`);
  assert.equal(build('divergent', {
    inventory: inventory(schemaPlan, 'divergent', { unexpectedObjects: accepted })
  }).outcome, 'blocked');
  rejects(() => build('divergent', {
    inventory: inventory(schemaPlan, 'divergent', {
      unexpectedObjects: [...accepted, 'unexpected_20']
    })
  }));
  rejects(() => build('divergent', {
    inventory: inventory(schemaPlan, 'divergent', {
      unexpectedObjects: ['schema.table']
    })
  }));
});

test('invalid instants and non-finite numbers stay behind one error boundary', () => {
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  for (const generatedAt of [
    '2026-09-12T15:00:00Z', '2026-02-30T15:00:00.000Z', '', null
  ]) rejects(() => build('empty', { generatedAt }));
  rejects(() => buildBankAccountPostgresPlan({
    schemaPlan,
    target: target({ postgresMajor: Number.POSITIVE_INFINITY }),
    inventory: inventory(schemaPlan),
    generatedAt: GENERATED_AT
  }));
});

test('hostile accessors, proxies and cyclic inputs are refused', () => {
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  const accessor = target();
  Object.defineProperty(accessor, 'targetRef', {
    enumerable: true,
    get() { throw new Error('must not run'); }
  });
  rejects(() => build('empty', { target: accessor }));
  rejects(() => build('empty', { target: new Proxy(target(), {}) }));
  const candidate = inventory(schemaPlan, 'conformant');
  candidate.catalog.loop = candidate.catalog;
  candidate.catalogFingerprint = '0'.repeat(64);
  rejects(() => buildBankAccountPostgresPlan({
    schemaPlan,
    target: target(),
    inventory: candidate,
    generatedAt: GENERATED_AT
  }));
});

test('inputs are cloned and never mutated by planning', () => {
  const schemaPlan = buildBankAccountPostgresOfflinePlan();
  const targetInput = target();
  const inventoryInput = inventory(schemaPlan, 'empty');
  const targetBefore = structuredClone(targetInput);
  const inventoryBefore = structuredClone(inventoryInput);
  const plan = buildBankAccountPostgresPlan({
    schemaPlan,
    target: targetInput,
    inventory: inventoryInput,
    generatedAt: GENERATED_AT
  });
  assert.deepEqual(targetInput, targetBefore);
  assert.deepEqual(inventoryInput, inventoryBefore);
  targetInput.targetRef = 'local-bank-accounts-ephemeral-999';
  assert.equal(plan.target.targetRef, targetBefore.targetRef);
});

test('planner exposes no authorization or executable operation', () => {
  const plan = build('empty');
  assert.equal(Object.hasOwn(plan, 'authorization'), false);
  assert.equal(Object.hasOwn(plan, 'execute'), false);
  assert.equal(Object.hasOwn(plan, 'rollback'), false);
  assert.equal(plan.executionAuthorized, false);
  assert.deepEqual(plan.destructiveStatements, []);
});

test('pure planner is not wired to drivers, routes, environment or migrations', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'bankAccountPostgresPlanner.js'
  ), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const migrations = fs.readFileSync(path.join(__dirname, '..', 'schemaMigrations.js'), 'utf8');
  assert.doesNotMatch(source,
    /express|@google-cloud|@electric-sql|require\(['"]pg['"]\)|process\.env|Date\.now|node:fs|node:http|node:https|\.query\(|\.connect\(|\.exec\(/i);
  assert.doesNotMatch(server, /bankAccountPostgresPlanner/);
  assert.doesNotMatch(migrations, /bankAccountPostgresPlanner/);
});

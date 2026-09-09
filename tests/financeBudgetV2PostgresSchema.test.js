const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONTRACT_ID,
  CURRENT_TABLE,
  EVENT_TABLE,
  LIST_INDEX,
  SCHEMA_NAME,
  buildBudgetV2PostgresOfflinePlan,
  validateBudgetV2PostgresInspection
} = require('../financeBudgetV2PostgresSchema');

function clone(value) {
  return structuredClone(value);
}

function inspectionFor(plan, overrides = {}) {
  return {
    postgresMajor: 18,
    ...clone(plan.expectedCatalog),
    ...overrides
  };
}

function rejects(run) {
  assert.throws(run, error => error?.code === 'BUDGET_V2_POSTGRES_SCHEMA_INVALID'
    && error.message === 'Invalid Budget V2 PostgreSQL schema plan');
}

test('offline plan is deterministic, closed and deeply frozen', () => {
  const first = buildBudgetV2PostgresOfflinePlan();
  const second = buildBudgetV2PostgresOfflinePlan();
  assert.equal(first.contractId, CONTRACT_ID);
  assert.equal(first.schemaName, SCHEMA_NAME);
  assert.equal(first.transactionIsolation, 'READ COMMITTED');
  assert.equal(first.applyMode, 'offline-only');
  assert.equal(first.requiresExistingSchema, true);
  assert.equal(first.statements.length, 3);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.statements), true);
  assert.equal(Object.isFrozen(first.expectedCatalog.tables[0].columns), true);
});

test('only the dedicated fixed schema is accepted', () => {
  assert.equal(buildBudgetV2PostgresOfflinePlan({ schemaName: SCHEMA_NAME }).schemaName,
    SCHEMA_NAME);
  for (const schemaName of [
    '', 'public', 'ref01', 'finance_budget_v1', 'finance-budget-v2',
    'finance_budget_v2; DROP TABLE x', 'pg_catalog'
  ]) rejects(() => buildBudgetV2PostgresOfflinePlan({ schemaName }));
});

test('DDL creates only the two V2 tables and the bounded list index', () => {
  const plan = buildBudgetV2PostgresOfflinePlan();
  const sql = plan.statements.join('\n');
  assert.match(plan.statements[0], new RegExp(`^CREATE TABLE "${SCHEMA_NAME}"\\."${CURRENT_TABLE}"`));
  assert.match(plan.statements[1], new RegExp(`^CREATE TABLE "${SCHEMA_NAME}"\\."${EVENT_TABLE}"`));
  assert.match(plan.statements[2], new RegExp(`^CREATE INDEX "${LIST_INDEX}"`));
  assert.equal((sql.match(/CREATE TABLE/g) || []).length, 2);
  assert.equal((sql.match(/CREATE INDEX/g) || []).length, 1);
  assert.doesNotMatch(sql, /CREATE SCHEMA|ALTER TABLE|DROP |GRANT |REVOKE |finance_budget_drafts_v1/i);
});

test('current table enforces scope, version, bytes and stable list order', () => {
  const sql = buildBudgetV2PostgresOfflinePlan().statements[0];
  assert.match(sql, /PRIMARY KEY \(tenant_id, author_user_id, id\)/);
  assert.match(sql, /contract_version = 2/);
  assert.match(sql, /version BETWEEN 1 AND 1000000/);
  assert.match(sql, /scope = 'organization'/);
  assert.match(sql, /status = 'draft'/);
  assert.match(sql, /access = 'owner-only'/);
  assert.match(sql, /document_bytes BETWEEN 1 AND 4194304/);
  assert.match(sql, /octet_length\(document_json\) = document_bytes/);
  assert.match(sql, /created_at <= updated_at/);
  assert.match(buildBudgetV2PostgresOfflinePlan().statements[2],
    /tenant_id ASC, author_user_id ASC, updated_at DESC, id ASC/);
});

test('event table keeps audit minimal, unique and tied to the current draft', () => {
  const sql = buildBudgetV2PostgresOfflinePlan().statements[1];
  assert.match(sql, /event_id BIGINT GENERATED ALWAYS AS IDENTITY/);
  assert.match(sql, /UNIQUE \(\s*tenant_id, actor_user_id, draft_id, version, action\s*\)/);
  assert.match(sql, /action IN \('budget_v2_draft_created', 'budget_v2_draft_updated'\)/);
  assert.match(sql, /FOREIGN KEY \(\s*tenant_id, actor_user_id, draft_id\s*\)/);
  assert.match(sql, /ON UPDATE RESTRICT ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /title|entity|year|document_json|document_bytes|amount|currency/);
});

test('closed catalog inspection accepts only the exact candidate contract', () => {
  const plan = buildBudgetV2PostgresOfflinePlan();
  assert.deepEqual(validateBudgetV2PostgresInspection(plan, inspectionFor(plan)), {
    valid: true,
    fingerprint: plan.fingerprint,
    postgresMajor: 18
  });
  for (const postgresMajor of [16, 17]) {
    assert.equal(validateBudgetV2PostgresInspection(
      plan, inspectionFor(plan, { postgresMajor })
    ).postgresMajor, postgresMajor);
  }
});

test('inspection refuses engine, version, encoding, schema and unexpected objects', () => {
  const plan = buildBudgetV2PostgresOfflinePlan();
  for (const change of [
    value => { value.postgresMajor = 15; },
    value => { value.postgresMajor = 19; },
    value => { value.engine = 'bigquery'; },
    value => { value.databaseEncoding = 'LATIN1'; },
    value => { value.schemaName = 'public'; },
    value => { value.views.push('budget_v2_open'); },
    value => { value.triggers.push('repair_budget'); },
    value => { value.routines.push('retry_budget'); },
    value => { value.extensions.push('pgcrypto'); },
    value => { value.grants.push({ grantee: 'PUBLIC', privilege: 'SELECT' }); }
  ]) {
    const inspection = inspectionFor(plan);
    change(inspection);
    rejects(() => validateBudgetV2PostgresInspection(plan, inspection));
  }
});

test('inspection refuses column, constraint, relation and index drift', () => {
  const plan = buildBudgetV2PostgresOfflinePlan();
  for (const change of [
    value => { value.tables[0].columns[0].nullable = true; },
    value => { value.tables[0].columns[2].type = 'text'; },
    value => { value.tables[0].columns.splice(1, 1); },
    value => { value.tables[0].primaryKey.columns.reverse(); },
    value => { value.tables[0].checks.pop(); },
    value => { value.tables[0].indexes[0].columns[2].direction = 'asc'; },
    value => { value.tables[1].uniqueConstraints = []; },
    value => { value.tables[1].foreignKeys[0].onDelete = 'cascade'; },
    value => { value.tables.push({ name: 'finance_budget_drafts_v1' }); }
  ]) {
    const inspection = inspectionFor(plan);
    change(inspection);
    rejects(() => validateBudgetV2PostgresInspection(plan, inspection));
  }
});

test('tampered or open plans are refused before inspection', () => {
  const plan = buildBudgetV2PostgresOfflinePlan();
  for (const change of [
    value => { value.statements[0] += '; DROP TABLE x'; },
    value => { value.fingerprint = '0'.repeat(64); },
    value => { value.applyMode = 'execute'; },
    value => { value.unexpected = true; }
  ]) {
    const tampered = clone(plan);
    change(tampered);
    rejects(() => validateBudgetV2PostgresInspection(tampered, inspectionFor(plan)));
  }
});

test('pure lot contains no route, driver, cloud, environment or execution wiring', () => {
  const moduleSource = fs.readFileSync(path.join(
    __dirname, '..', 'financeBudgetV2PostgresSchema.js'
  ), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const migrationsSource = fs.readFileSync(path.join(
    __dirname, '..', 'schemaMigrations.js'
  ), 'utf8');
  assert.doesNotMatch(moduleSource,
    /express|@google-cloud|@electric-sql|require\(['"]pg['"]\)|process\.env|\.query\(|\.connect\(|\.exec\(/i);
  assert.doesNotMatch(serverSource, /financeBudgetV2PostgresSchema/);
  assert.doesNotMatch(migrationsSource, /financeBudgetV2PostgresSchema/);
});

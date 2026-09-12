'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ACCESS_TABLE,
  AUDIT_TABLE,
  CONTRACT_ID,
  FORBIDDEN_COLUMN_NAMES,
  INDEX_NAMES,
  RELATION_TABLE,
  REVISION_TABLE,
  SCHEMA_NAME,
  VERSION_TABLE,
  buildBankAccountPostgresOfflinePlan,
  validateBankAccountPostgresInspection,
  validateBankAccountPostgresOfflinePlan
} = require('../bankAccountPostgresSchema');

function clone(value) {
  return structuredClone(value);
}

function rejects(run) {
  assert.throws(run, error => error?.code === 'BANK_ACCOUNT_POSTGRES_SCHEMA_INVALID'
    && error.message === 'Invalid bank account PostgreSQL offline schema plan');
}

function query(plan, code) {
  return plan.queries.find(candidate => candidate.code === code);
}

function inspectionFor(plan, postgresMajor = 18) {
  return { postgresMajor, ...clone(plan.expectedCatalog) };
}

test('1 - offline plan is deterministic, closed and deeply frozen', () => {
  const first = buildBankAccountPostgresOfflinePlan();
  const second = buildBankAccountPostgresOfflinePlan();
  assert.equal(first.contractId, CONTRACT_ID);
  assert.equal(first.schemaName, SCHEMA_NAME);
  assert.equal(first.applyMode, 'offline-only');
  assert.equal(first.requiresExistingSchema, true);
  assert.equal(first.transactionIsolation, 'REPEATABLE READ');
  assert.equal(first.dataClass, 'MASKED_ORGANIZATIONAL_METADATA_ONLY');
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.statements), true);
  assert.equal(Object.isFrozen(first.queries[0]), true);
  assert.equal(Object.isFrozen(first.expectedCatalog.tables[0].columns), true);
  assert.equal(Object.isFrozen(first.expectedCatalog.tables[0].constraints), true);
  assert.equal(Object.isFrozen(first.expectedCatalog.indexes[0]), true);
});

test('2 - only the fixed dedicated schema is accepted', () => {
  assert.equal(buildBankAccountPostgresOfflinePlan({ schemaName: SCHEMA_NAME }).schemaName,
    SCHEMA_NAME);
  for (const schemaName of [
    '', 'public', 'finance', 'finance_bank_account', 'finance-bank-accounts',
    'finance_bank_accounts; DROP TABLE x', 'pg_catalog'
  ]) rejects(() => buildBankAccountPostgresOfflinePlan({ schemaName }));

  rejects(() => buildBankAccountPostgresOfflinePlan({}));
  rejects(() => buildBankAccountPostgresOfflinePlan({ schemaName: SCHEMA_NAME, extra: true }));
  const accessor = {};
  Object.defineProperty(accessor, 'schemaName', {
    enumerable: true,
    get() { throw new Error('leak'); }
  });
  rejects(() => buildBankAccountPostgresOfflinePlan(accessor));
  const revocable = Proxy.revocable({ schemaName: SCHEMA_NAME }, {});
  revocable.revoke();
  rejects(() => buildBankAccountPostgresOfflinePlan(revocable.proxy));
});

test('3 - catalog contains exactly the five governed logical tables', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  assert.deepEqual(plan.expectedCatalog.tables.map(table => table.name), [
    VERSION_TABLE, RELATION_TABLE, REVISION_TABLE, ACCESS_TABLE, AUDIT_TABLE
  ]);
  assert.equal(plan.expectedCatalog.views.length, 0);
  assert.equal(plan.expectedCatalog.triggers.length, 0);
  assert.equal(plan.expectedCatalog.routines.length, 0);
  assert.equal(plan.expectedCatalog.extensions.length, 0);
  assert.equal(plan.expectedCatalog.grants.length, 0);
  assert.deepEqual(plan.expectedCatalog.indexes.map(index => index.name),
    Object.values(INDEX_NAMES));
});

test('4 - DDL creates only five tables and five indexes without applying a schema', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  const sql = plan.statements.join('\n');
  assert.equal(plan.statements.length, 10);
  assert.equal((sql.match(/CREATE TABLE/g) || []).length, 5);
  assert.equal((sql.match(/CREATE (?:UNIQUE )?INDEX/g) || []).length, 5);
  assert.doesNotMatch(sql,
    /CREATE SCHEMA|IF NOT EXISTS|ALTER TABLE|DROP |TRUNCATE |GRANT |REVOKE |CREATE ROLE/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|ON UPDATE CASCADE/i);
});

test('5 - version table maps the masked summary fields and preserves history', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  const table = plan.expectedCatalog.tables.find(item => item.name === VERSION_TABLE);
  const names = table.columns.map(item => item.name);
  assert.deepEqual(table.primaryKey, ['tenant_id', 'bank_account_id', 'record_version']);
  for (const name of [
    'holder_entity_id', 'holder_entity_source_revision',
    'financial_institution_id', 'financial_institution_source_revision',
    'business_owner_agent_id', 'business_owner_agent_source_revision',
    'internal_label', 'internal_label_order', 'account_type', 'currency', 'status', 'visible',
    'masked_identifier', 'classification', 'effective_from', 'effective_to',
    'source_revision', 'verified_at', 'record_version', 'replaced_at'
  ]) assert.equal(names.includes(name), true, name);
  for (const forbidden of FORBIDDEN_COLUMN_NAMES) {
    assert.equal(names.includes(forbidden), false, forbidden);
  }
  const ddl = plan.statements[0];
  assert.match(ddl, /record_version BETWEEN 1 AND 1000000/);
  assert.match(ddl, /char_length\(masked_identifier\) BETWEEN 8 AND 34/);
  assert.match(ddl, /masked_identifier ~ '\^\\\*\{4,34\}\[A-Za-z0-9\]\{0,4\}\$'/);
  assert.match(ddl,
    /business_owner_agent_id IS NULL AND business_owner_agent_source_revision IS NULL/);
  assert.match(ddl,
    /status IN \('candidate', 'verification_pending'\) AND verified_at IS NULL/);
  assert.match(ddl,
    /status IN \('active', 'suspended', 'closed'\) AND verified_at IS NOT NULL/);
  assert.match(ddl,
    /\(internal_label_order COLLATE "C"\) = \(internal_label COLLATE "C"\)/);
  assert.match(ddl, /internal_label IS NFC NORMALIZED/);
  assert.match(ddl, /internal_label !~ '\[\[:cntrl:\]\]'/);
  assert.match(ddl, /regexp_replace\(internal_label/);
  assert.match(ddl, /replaced_at IS NULL OR replaced_at > created_at/);
});

test('6 - one partial unique index permits only one current version', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  const currentIndex = plan.statements.find(statement => statement.includes(INDEX_NAMES.current));
  const listIndex = plan.statements.find(statement => statement.includes(INDEX_NAMES.list));
  const filterIndex = plan.statements.find(statement => statement.includes(INDEX_NAMES.filters));
  assert.match(currentIndex, /CREATE UNIQUE INDEX/);
  assert.match(currentIndex, /tenant_id, bank_account_id/);
  assert.match(currentIndex, /WHERE replaced_at IS NULL/);
  assert.match(listIndex, /internal_label_order COLLATE "C", bank_account_id/);
  assert.match(listIndex,
    /WHERE replaced_at IS NULL AND status = 'active' AND visible IS TRUE/);
  assert.match(filterIndex,
    /tenant_id, status, classification, account_type, currency/);
  assert.match(filterIndex, /holder_entity_id, financial_institution_id/);
  assert.match(filterIndex,
    /WHERE replaced_at IS NULL AND status = 'active' AND visible IS TRUE/);
});

test('7 - relation snapshots are versioned and institution-only fields are closed', () => {
  const ddl = buildBankAccountPostgresOfflinePlan().statements[1];
  assert.match(ddl,
    /PRIMARY KEY \(\s*tenant_id, relation_kind, reference_id, source_revision\s*\)/);
  assert.match(ddl,
    /relation_kind IN \('holder_entity', 'financial_institution', 'business_owner_agent'\)/);
  assert.match(ddl, /label_snapshot IS NFC NORMALIZED/);
  assert.match(ddl, /label_snapshot !~ '\[\[:cntrl:\]\]'/);
  assert.match(ddl, /relation_kind = 'financial_institution'/);
  assert.match(ddl, /country_id IS NOT NULL/);
  assert.match(ddl, /relation_kind <> 'financial_institution'/);
  assert.match(ddl, /country_id IS NULL AND institution_type IS NULL/);
});

test('8 - revisions, access projection and audit remain minimal and bounded', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  const revisions = plan.statements[2];
  const access = plan.statements[3];
  const audit = plan.statements[4];
  assert.match(revisions, /schema_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(revisions, /policy_revision VARCHAR\(128\) NOT NULL/);
  assert.match(revisions, /generation >= 1/);
  assert.match(access, /max_classification IN \('C2', 'C3'\)/);
  assert.match(access, /effective_to IS NULL OR effective_to > effective_from/);
  assert.match(audit, /operation IN \('created', 'updated', 'status_changed', 'access_rebuilt'\)/);
  assert.doesNotMatch(audit,
    /internal_label|masked_identifier|currency|amount|content|payload|document/i);
});

test('9 - query catalog is exact, bounded and positional', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  assert.deepEqual(plan.queries.map(item => item.code), [
    'Q-01', 'Q-02', 'Q-03', 'Q-04', 'Q-05', 'Q-06', 'Q-07'
  ]);
  for (const candidate of plan.queries) {
    const numbers = [...candidate.text.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.equal(Math.max(...numbers), candidate.parameterCount, candidate.code);
    assert.doesNotMatch(candidate.text, /\$\{|\+\s*(?:tenant|actor|filter|order|limit)/i);
    assert.doesNotMatch(candidate.text, /SELECT\s+\*/i);
  }
  assert.equal(query(plan, 'Q-03').maxRows, 51);
  assert.equal(query(plan, 'Q-04').maxRows, 1);
  assert.equal(query(plan, 'Q-07').mode, 'future-write-not-authorized');
});

test('10 - exact account and relation reads are tenant-bound and limit cardinality to two', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  const account = query(plan, 'Q-01').text;
  const relation = query(plan, 'Q-02').text;
  assert.match(account, /WHERE a\.tenant_id = \$1/);
  assert.match(account, /a\.bank_account_id = \$2/);
  assert.match(account, /LIMIT 2$/);
  assert.match(account, /relation_kind = 'holder_entity'/);
  assert.match(account, /relation_kind = 'financial_institution'/);
  assert.match(account, /relation_kind = 'business_owner_agent'/);
  assert.match(account, /LEFT JOIN/);
  assert.match(account, /a\.visible/);
  assert.match(account, /\$3::timestamptz AT TIME ZONE 'UTC'/);
  assert.match(relation, /WHERE tenant_id = \$1/);
  assert.match(relation, /source_revision = \$4/);
  assert.match(relation, /\$5::timestamptz AT TIME ZONE 'UTC'/);
  assert.match(relation, /LIMIT 2$/);
});

test('11 - list query uses six closed filters, access revision and keyset pagination', () => {
  const list = query(buildBankAccountPostgresOfflinePlan(), 'Q-03').text;
  for (const columnName of [
    'holder_entity_id', 'financial_institution_id', 'account_type',
    'currency', 'status', 'classification'
  ]) assert.match(list, new RegExp(`a\\.${columnName} = \\$\\d+`));
  assert.match(list, /p\.tenant_id = \$1/);
  assert.match(list, /p\.actor_id = \$2/);
  assert.match(list, /p\.policy_revision = \$4/);
  assert.match(list, /r\.list_revision = \$13/);
  assert.match(list, /r\.source_revision = \$14/);
  assert.match(list, /r\.policy_revision = p\.policy_revision/);
  assert.doesNotMatch(list, /a\.source_revision = r\.source_revision/);
  assert.match(list, /a\.visible IS TRUE/);
  assert.match(list, /\$3::timestamptz AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(list, /\$3::date/);
  for (const alias of ['he', 'fi', 'ag']) {
    assert.match(list, new RegExp(`${alias}\\.active IS TRUE`));
    assert.match(list, new RegExp(`${alias}\\.visible IS TRUE`));
    assert.match(list, new RegExp(`${alias}\\.source_revision = a\\.`));
  }
  assert.match(list, /a\.business_owner_agent_id IS NULL OR EXISTS/);
  assert.match(list,
    /\(a\.internal_label_order COLLATE "C", a\.bank_account_id\) >/);
  assert.match(list,
    /ORDER BY a\.internal_label_order COLLATE "C" ASC, a\.bank_account_id ASC/);
  assert.match(list, /LIMIT \$15$/);
  assert.doesNotMatch(list, /OFFSET|ORDER BY\s+\$/i);
});

test('12 - list and total share the authorized filtered predicate', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  const list = query(plan, 'Q-03').text;
  const total = query(plan, 'Q-04').text;
  const shared = [
    'p.tenant_id = $1', 'p.actor_id = $2', 'p.policy_revision = $4',
    "a.classification = 'C2' OR p.max_classification = 'C3'",
    'a.holder_entity_id = $5', 'a.financial_institution_id = $6',
    'a.account_type = $7', 'a.currency = $8', 'a.status = $9',
    'a.classification = $10', 'a.replaced_at IS NULL', "a.status = 'active'",
    'a.visible IS TRUE', "he.relation_kind = 'holder_entity'",
    "fi.relation_kind = 'financial_institution'",
    "ag.relation_kind = 'business_owner_agent'"
  ];
  for (const predicate of shared) {
    assert.equal(list.includes(predicate), true, predicate);
    assert.equal(total.includes(predicate), true, predicate);
  }
  assert.match(total, /COUNT\(\*\)::integer AS authorized_filtered_count/);
  assert.match(total, /r\.list_revision = \$11/);
  assert.match(total, /r\.source_revision = \$12/);
  assert.match(total, /r\.policy_revision = p\.policy_revision/);
  assert.doesNotMatch(total, /a\.source_revision = r\.source_revision/);
});

test('13 - plan validation accepts only the exact immutable candidate', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  assert.deepEqual(validateBankAccountPostgresOfflinePlan(plan), {
    valid: true,
    fingerprint: plan.fingerprint
  });
  const changedQuery = clone(plan);
  changedQuery.queries[0].text += ' ';
  rejects(() => validateBankAccountPostgresOfflinePlan(changedQuery));
  const changedCatalog = clone(plan);
  changedCatalog.expectedCatalog.tables[0].columns.push({ name: 'iban', type: 'text' });
  rejects(() => validateBankAccountPostgresOfflinePlan(changedCatalog));
});

test('14 - closed catalog inspection accepts PostgreSQL 16 to 18 only', () => {
  const plan = buildBankAccountPostgresOfflinePlan();
  for (const postgresMajor of [16, 17, 18]) {
    assert.deepEqual(validateBankAccountPostgresInspection(
      plan, inspectionFor(plan, postgresMajor)
    ), { valid: true, fingerprint: plan.fingerprint, postgresMajor });
  }
  for (const postgresMajor of [15, 19, '18', null]) {
    rejects(() => validateBankAccountPostgresInspection(
      plan, inspectionFor(plan, postgresMajor)
    ));
  }
  const unexpected = inspectionFor(plan);
  unexpected.tables.push({ name: 'unexpected' });
  rejects(() => validateBankAccountPostgresInspection(plan, unexpected));

  const weakenedIndex = inspectionFor(plan);
  weakenedIndex.indexes[0].unique = false;
  rejects(() => validateBankAccountPostgresInspection(plan, weakenedIndex));

  const missingPredicate = inspectionFor(plan);
  missingPredicate.indexes[1].predicate = null;
  rejects(() => validateBankAccountPostgresInspection(plan, missingPredicate));

  const weakenedConstraint = inspectionFor(plan);
  weakenedConstraint.tables[0].constraints.find(candidate => (
    candidate.name === 'ck_bank_account_versions_mask'
  )).rule = 'masked_identifier is nonblank';
  rejects(() => validateBankAccountPostgresInspection(plan, weakenedConstraint));
});

test('15 - hostile plans and inspections are refused without invoking accessors', () => {
  const plan = clone(buildBankAccountPostgresOfflinePlan());
  Object.defineProperty(plan, 'engine', { enumerable: true, get() { throw new Error('leak'); } });
  rejects(() => validateBankAccountPostgresOfflinePlan(plan));

  const symbolPlan = clone(buildBankAccountPostgresOfflinePlan());
  symbolPlan[Symbol('hidden')] = true;
  rejects(() => validateBankAccountPostgresOfflinePlan(symbolPlan));

  const revocable = Proxy.revocable(clone(buildBankAccountPostgresOfflinePlan()), {});
  revocable.revoke();
  rejects(() => validateBankAccountPostgresOfflinePlan(revocable.proxy));

  const inspection = inspectionFor(buildBankAccountPostgresOfflinePlan());
  inspection.self = inspection;
  rejects(() => validateBankAccountPostgresInspection(
    buildBankAccountPostgresOfflinePlan(), inspection
  ));

  const tooDeep = {};
  let cursor = tooDeep;
  for (let depth = 0; depth < 100; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  rejects(() => validateBankAccountPostgresOfflinePlan(tooDeep));
});

test('16 - module has no runtime database, environment, file or network dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bankAccountPostgresSchema.js'), 'utf8');
  assert.doesNotMatch(source,
    /express|@google-cloud|@electric-sql|require\(['"]pg['"]\)|process\.env|fetch\(|https?\.|\.query\(|\.connect\(|\.exec\(/i);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const migrations = fs.readFileSync(path.join(__dirname, '..', 'schemaMigrations.js'), 'utf8');
  assert.doesNotMatch(server, /bankAccountPostgresSchema/);
  assert.doesNotMatch(migrations, /bankAccountPostgresSchema/);
});

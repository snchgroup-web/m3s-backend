'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const {
  REVISION_TABLE,
  SCHEMA_NAME,
  buildBankAccountPostgresOfflinePlan
} = require('../bankAccountPostgresSchema');
const {
  BankAccountPGliteProofError,
  CONTROL_IDS,
  buildSyntheticCorpus,
  collectInventory,
  runBankAccountPGliteProof,
  validateSyntheticCorpus
} = require('./helpers/bankAccountPGliteProofHarness');

test('CB-1-D-C-A proves all 28 controls in an in-memory PostgreSQL counter-test', async () => {
  const report = await runBankAccountPGliteProof();

  assert.deepEqual(report, {
    contractId: 'M3S-CB-1-D-C-A-001',
    engine: 'pglite-postgresql',
    storageMode: 'memory-only',
    dataClassification: 'synthetic-masked-only',
    controlCount: 28,
    passedControls: CONTROL_IDS,
    cleanupVerified: true,
    verdict: 'PASS-EPHEMERAL'
  });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.passedControls), true);
  assert.doesNotMatch(
    JSON.stringify(report),
    /tenant-cb|actor-cb|holder|institution|account_id|label|iban|amount|transaction/i
  );
});

test('constraint drift with an unchanged name and type is rejected', async () => {
  const database = new PGlite();
  try {
    const schemaPlan = buildBankAccountPostgresOfflinePlan();
    await database.exec(`CREATE SCHEMA "${SCHEMA_NAME}"`);
    for (const statement of schemaPlan.statements) await database.exec(statement);

    const conformant = await collectInventory(database, schemaPlan);
    assert.equal(conformant.schemaState, 'conformant');

    await database.exec(`ALTER TABLE "${SCHEMA_NAME}"."${REVISION_TABLE}"
      DROP CONSTRAINT ck_bank_account_revisions_generation`);
    await database.exec(`ALTER TABLE "${SCHEMA_NAME}"."${REVISION_TABLE}"
      ADD CONSTRAINT ck_bank_account_revisions_generation CHECK (true)`);

    const divergent = await collectInventory(database, schemaPlan);
    assert.equal(divergent.schemaState, 'divergent');
    assert.deepEqual(divergent.unexpectedObjects, ['catalog-drift']);
  } finally {
    await database.close();
  }
});

test('column default drift is rejected even when the remaining metadata is unchanged', async () => {
  const database = new PGlite();
  try {
    const schemaPlan = buildBankAccountPostgresOfflinePlan();
    await database.exec(`CREATE SCHEMA "${SCHEMA_NAME}"`);
    for (const statement of schemaPlan.statements) await database.exec(statement);

    const conformant = await collectInventory(database, schemaPlan);
    assert.equal(conformant.schemaState, 'conformant');

    await database.exec(`ALTER TABLE "${SCHEMA_NAME}"."${REVISION_TABLE}"
      ALTER COLUMN generation SET DEFAULT 1`);

    const divergent = await collectInventory(database, schemaPlan);
    assert.equal(divergent.schemaState, 'divergent');
    assert.deepEqual(divergent.unexpectedObjects, ['catalog-drift']);
  } finally {
    await database.close();
  }
});

test('timestamp precision drift is rejected even when the data type is unchanged', async () => {
  const database = new PGlite();
  try {
    const schemaPlan = buildBankAccountPostgresOfflinePlan();
    await database.exec(`CREATE SCHEMA "${SCHEMA_NAME}"`);
    for (const statement of schemaPlan.statements) await database.exec(statement);

    const conformant = await collectInventory(database, schemaPlan);
    assert.equal(conformant.schemaState, 'conformant');

    await database.exec(`ALTER TABLE "${SCHEMA_NAME}"."${REVISION_TABLE}"
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ(0)`);

    const divergent = await collectInventory(database, schemaPlan);
    assert.equal(divergent.schemaState, 'divergent');
    assert.deepEqual(divergent.unexpectedObjects, ['catalog-drift']);
  } finally {
    await database.close();
  }
});

test('synthetic corpus validation fails before creating the in-memory engine', async () => {
  const invalidCorpus = structuredClone(buildSyntheticCorpus('a'.repeat(64)));
  invalidCorpus.accounts[0].source_revision = 'CH9300762011623852957';

  for (const value of [
    'CH9300762011623852957',
    'CH93 0076 2011 6238 5295 7',
    'CH93.0076.2011.6238.5295.7',
    'CH93-0076-2011-6238-5295-7'
  ]) {
    const candidate = structuredClone(buildSyntheticCorpus('a'.repeat(64)));
    candidate.accounts[0].source_revision = value;
    assert.throws(
      () => validateSyntheticCorpus(candidate),
      error => error instanceof BankAccountPGliteProofError
        && error.code === 'BANK_ACCOUNT_EPHEMERAL_PROOF_FAILED'
        && !error.message.includes('IBAN')
    );
  }
  const report = await runBankAccountPGliteProof({ corpusFactory: () => invalidCorpus });
  assert.equal(report.verdict, 'FAIL-CONTRACT');
  assert.equal(report.passedControls.includes(3), false);
  assert.equal(report.passedControls.includes(4), false);
  assert.equal(report.cleanupVerified, false);
});

test('unexpected proof failures remain contract failures rather than compatibility blocks', async () => {
  const report = await runBankAccountPGliteProof({
    corpusFactory() {
      throw new TypeError('synthetic JavaScript regression');
    }
  });
  assert.equal(report.verdict, 'FAIL-CONTRACT');
  assert.equal(report.passedControls.includes(3), false);
});

test('the proof harness stays test-only and has no external or persistent capability', () => {
  const helperPath = path.join(
    __dirname, 'helpers', 'bankAccountPGliteProofHarness.js'
  );
  const helper = fs.readFileSync(helperPath, 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'), 'utf8'
  ));

  assert.equal(packageJson.devDependencies['@electric-sql/pglite'], '0.5.7');
  assert.match(helper, /new PGlite\(\)/);
  assert.doesNotMatch(helper,
    /node:fs|node:http|node:https|require\(['"]pg['"]\)|@supabase|process\.env|fetch\(|new PGlite\([^)]/i);
  assert.doesNotMatch(server, /bankAccountPGliteProofHarness|M3S-CB-1-D-C-A-001/);
});

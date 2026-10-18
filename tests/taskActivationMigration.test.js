const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CONTRACTS, TARGET, assertNativeTable, registrationRows, buildApprovedTaskMigration } = require('../taskActivationMigration');
test('approved migration is bounded to five new durable tables and six exact references', () => {
  const p = buildApprovedTaskMigration('authenticated-id@opaque');
  assert.equal(p.createStatements.length, 5);
  for (const sql of p.createStatements) {
    assert.match(sql, /OPTIONS \(expiration_timestamp = NULL/);
    assert.doesNotMatch(sql, /\b(ALTER|DROP|GRANT|DELETE|TRUNCATE|REPLACE)\b/);
  }
  assert.equal(Object.values(p.rows).flat().length, 6);
  assert.equal(p.rows.management_task_assignments[0].actor_user_id, 'authenticated-id@opaque');
  assert.match(p.registrationSql, /BEGIN TRANSACTION/); assert.match(p.registrationSql, /COMMIT TRANSACTION/);
  assert.match(p.registrationSql, /TASK_MIGRATION_TARGET_NOT_EMPTY/);
  assert.doesNotMatch(p.registrationSql, /\b(UPDATE|DELETE|GRANT|MERGE|TRUNCATE)\b/);
  assert.doesNotMatch(p.registrationSql, /INSERT INTO `[^`]+\.administration_tasks`/);
  assert.match(p.registrationSql, /@actor/); assert.doesNotMatch(p.registrationSql, /authenticated-id@opaque/);
});
test('identity must be supplied exactly, never inferred from a person', () => {
  for (const id of [null, '', ' leading', 'trailing ', 'line\nfeed', 'x'.repeat(201)]) assert.throws(() => registrationRows(id));
});
test('native metadata validation refuses target drift, expiry and incompatible existing tables', () => {
  for (const [name, c] of Object.entries(CONTRACTS)) {
    const m = { type:'TABLE', location:'US', tableReference:{projectId:TARGET.projectId,datasetId:TARGET.datasetId,tableId:name},
      schema:{fields:c.fields}, clustering:{fields:c.clustering}, ...(c.partitionField ? {timePartitioning:{type:'DAY',field:c.partitionField}} : {}) };
    assert.doesNotThrow(() => assertNativeTable(name,m));
    for (const patch of [{type:'VIEW'},{location:'EU'},{expirationTime:'123'},{schema:{fields:[]}}, {tableReference:{...m.tableReference,datasetId:'foreign'}}]) {
      assert.throws(() => assertNativeTable(name,{...m,...patch}));
    }
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FINANCE_DECISION_SHA256, buildFinancialStoragePlanCandidate, buildFinancialSchemaPreview, buildFinancialRegistrationPreview } = require('../taskFinancialStoragePlanCandidate');

test('storage proposal remains a non-executable design and reuses prepared references', () => {
  const plan = buildFinancialStoragePlanCandidate();
  assert.equal(plan.application_allowed, false);
  assert.equal(plan.activation_allowed, false);
  assert.deepEqual(plan.tables.map(t => t.candidate_name),
    ['management_operational_plans', 'management_operational_assignments']);
  assert.deepEqual(plan.tables[0].fields.find(f => f.name === 'dossier_id'),
    { name: 'dossier_id', type: 'STRING', mode: 'NULLABLE' });
  assert.equal(plan.tables[1].fields.find(f => f.name === 'operational_plan_id').mode, 'REQUIRED');
  assert.ok(plan.tables.every(t => t.partition_field === null));
  assert.equal(plan.prepared_plan.id, null);
  assert.equal(plan.prepared_assignment.id, null);
  assert.equal(plan.prepared_plan.portfolio_id, 'PORT-2SG-GLOBAL');
  assert.equal(plan.prepared_plan.function_id, 'finance');
  assert.equal(plan.prepared_assignment.status, 'inactive');
  assert.equal(plan.existing_evidence.durable_server_version_created, false);
  assert.equal(plan.existing_evidence.consultation_response_correspondence,
    'COR-de403d44-4f7d-4926-ba0d-f3ac6e20687f');
  assert.notEqual(plan.existing_evidence.consultation_response_correspondence,
    plan.existing_evidence.consultation_correspondence);
  assert.equal(plan.existing_evidence.local_excerpt_sha256.length, 64);
  assert.equal(plan.existing_evidence.server_verifier_connected, false);
  assert.equal(plan.concurrency_candidate.prevents_external_append, false);
  assert.equal(plan.concurrency_candidate.verified_in_production, false);
  assert.ok(plan.gates.includes('respect_existing_approval_and_required_controls'));
  assert.ok(plan.exclusions.includes('modify_permissions'));
});

test('schema preview only describes two distinct CREATE TABLE statements', () => {
  const preview = buildFinancialSchemaPreview();
  assert.equal(preview.application_allowed, false);
  assert.equal(preview.cloud_access, false);
  assert.deepEqual(preview.statements.map(s => s.table),
    ['management_operational_plans', 'management_operational_assignments']);
  for (const statement of preview.statements) {
    assert.match(statement.sql, /^CREATE TABLE `mon-projet-data-2sg\.m3s_2sg\.[a-z_]+`/);
    assert.doesNotMatch(statement.sql, /\b(?:REPLACE|IF NOT EXISTS|INSERT|UPDATE|DELETE|GRANT|DROP|ALTER|OPTIONS)\b/i);
    assert.equal((statement.sql.match(/;/g) || []).length, 1);
  }
  assert.match(preview.statements[0].sql, /`dossier_id` STRING[,\n]/);
  assert.match(preview.statements[1].sql, /`operational_plan_id` STRING NOT NULL/);
});

test('registration preview keeps plan, assignment and audit under the existing fence without changing rights', () => {
  const p = buildFinancialRegistrationPreview();
  assert.equal(p.status, 'preview_only');
  assert.equal(p.executable, false);
  assert.match(p.sql, /BEGIN TRANSACTION/);
  assert.match(p.sql, /UPDATE `mon-projet-data-2sg\.m3s_2sg\.administration_task_registry_state`/);
  assert.match(p.sql, /id='registry' AND revision>=0 AND revision=@finance_observed_revision\s+AND contract_version=@contract_version/);
  assert.match(p.sql, /FINANCE_PLAN_DUPLICATE/);
  assert.match(p.sql, /FINANCE_ASSIGNMENT_DUPLICATE/);
  assert.match(p.sql, /FINANCE_CONSULTATION_UNAVAILABLE/);
  assert.match(p.sql, /FINANCE_SOURCE_UNAVAILABLE/);
  assert.match(p.sql, /FINANCE_ACTOR_UNQUALIFIED/);
  assert.match(p.sql, /actor_user_id=@actor AND assignee_agent_id='PER-2SG-0001'/);
  assert.match(p.sql, /INSERT INTO `mon-projet-data-2sg\.m3s_2sg\.management_operational_plans`/);
  assert.match(p.sql, /INSERT INTO `mon-projet-data-2sg\.m3s_2sg\.management_operational_assignments`/);
  assert.match(p.sql, /INSERT INTO `mon-projet-data-2sg\.m3s_2sg\.administration_audit_log`/);
  assert.equal((p.sql.match(/INSERT INTO `mon-projet-data-2sg\.m3s_2sg\.administration_audit_log`/g) || []).length, 2);
  assert.match(p.sql, /'operational_assignment',@assignment_id/);
  assert.match(p.sql, /COMMIT TRANSACTION/);
  assert.doesNotMatch(p.sql, /\b(?:GRANT|REVOKE|DELETE|DROP|ALTER)\b/i);
  assert.ok(p.pending.includes('initial_approval_evidence_verified'));
  assert.ok(p.pending.includes('capture_registry_revision_and_bind_to_registration'));
  assert.ok(p.pending.includes('qualify_zero_additional_cost'));
  assert.doesNotMatch(p.sql, /FINANCE_GED_INTENT_HISTORY_PRESENT/);
  assert.ok(p.pending.includes('concurrency_review_external_writers'));
});

test('registration SQL can be reviewed against an explicitly selected isolated dataset', () => {
  const production = buildFinancialRegistrationPreview();
  const isolated = buildFinancialRegistrationPreview({ project: 'fixture-project', dataset: 'fixture_dataset' });
  assert.equal(isolated.executable, false);
  assert.equal(isolated.status, 'preview_only');
  assert.deepEqual(isolated.ids, production.ids);
  assert.doesNotMatch(isolated.sql, /mon-projet-data-2sg\.m3s_2sg/);
  assert.equal(isolated.sql.replaceAll('fixture-project.fixture_dataset', 'mon-projet-data-2sg.m3s_2sg'), production.sql);
});

test('registration preview rejects malformed or incomplete destinations without falling back to production', () => {
  for (const target of [null, [], {}, { project: 'fixture-project' }, { dataset: 'fixture_dataset' },
    { project: 'fixture-project', dataset: 'fixture_dataset', extra: true },
    { project: 42, dataset: 'fixture_dataset' }, { project: 'fixture-project', dataset: 42 },
    { project: 'fixture`project', dataset: 'fixture_dataset' },
    { project: 'fixture-project', dataset: 'fixture_dataset` ; DROP TABLE x' },
    { project: 'fixture-project', dataset: 'dataset.with.dot' }]) {
    assert.throws(() => buildFinancialRegistrationPreview(target), /FINANCE_REGISTRATION_TARGET_INVALID/);
  }
});

test('a changed or frozen fictional fence cannot authorize registration with an older observed revision', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE state (id TEXT, revision INTEGER, contract_version TEXT); INSERT INTO state VALUES ('registry', 5, 'v2')");
    const compare = db.prepare("UPDATE state SET revision=revision+1 WHERE id='registry' AND revision>=0 AND revision=? AND contract_version='v2'");
    assert.equal(compare.run(4).changes, 0);
    assert.equal(compare.run(5).changes, 1);
    assert.equal(compare.run(5).changes, 0);
    db.exec('UPDATE state SET revision=-7');
    assert.equal(compare.run(-7).changes, 0);
    assert.equal(db.prepare('SELECT revision FROM state').get().revision, -7);
  } finally { db.close(); }
});

// SQLite is only a local approximation. BigQuery-specific syntax and concurrent
// behavior still require a separate test against a genuinely isolated dataset.
function createLocalRegistrationFixture() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE administration_task_registry_state (id TEXT, revision INTEGER, contract_version TEXT);
    CREATE TABLE management_portfolios (tenant_id TEXT, portfolio_id TEXT, function_id TEXT, status TEXT, confidentiality TEXT, source_ref TEXT);
    CREATE TABLE administration_correspondence (tenant_id TEXT, id TEXT, direction TEXT, deleted_at TEXT, confidentiality TEXT, status TEXT);
    CREATE TABLE management_task_assignments (tenant_id TEXT, actor_user_id TEXT, assignee_agent_id TEXT, team_id TEXT, governance_status TEXT, status TEXT);
    CREATE TABLE management_operational_plans (id TEXT, tenant_id TEXT, source_key TEXT, label TEXT, portfolio_id TEXT, dossier_id TEXT, function_id TEXT, governance_status TEXT, status TEXT, registration_reference TEXT, decision_reference TEXT, decision_version TEXT, decision_sha256 TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE management_operational_assignments (id TEXT, tenant_id TEXT, source_key TEXT, operational_plan_id TEXT, actor_user_id TEXT, assignee_agent_id TEXT, team_id TEXT, function_id TEXT, module TEXT, governance_status TEXT, status TEXT, registration_reference TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE administration_audit_log (id TEXT, tenant_id TEXT, actor_user_id TEXT, actor_name TEXT, entity_type TEXT, entity_id TEXT, action TEXT, event_at TEXT, metadata_json TEXT);
    INSERT INTO administration_task_registry_state VALUES ('registry', 5, 'm3s.task-execution.v2');
    INSERT INTO management_portfolios VALUES ('2sg', 'PORT-2SG-GLOBAL', 'management_governance', 'active', 'internal', 'fixture-source');
    INSERT INTO administration_correspondence VALUES ('2sg', 'COR-de403d44-4f7d-4926-ba0d-f3ac6e20687f', 'incoming', NULL, 'internal', 'closed');
    INSERT INTO administration_correspondence VALUES ('2sg', 'COR-88832bd5-2231-42f3-a7d6-4f4e13a8cbe3', 'internal', NULL, 'internal', 'closed');
    INSERT INTO management_task_assignments VALUES ('2sg', 'fixture-user', 'PER-2SG-0001', 'TZH', 'approved', 'active');`);
  const preview = buildFinancialRegistrationPreview({ project: 'fixture-project', dataset: 'fixture_dataset' });
  const params = { finance_observed_revision: 5, contract_version: 'm3s.task-execution.v2', actor: 'fixture-user',
    plan_id: preview.ids.plan, assignment_id: preview.ids.assignment, plan_source: preview.ids.planSource,
    assignment_source: preview.ids.assignmentSource, label: buildFinancialStoragePlanCandidate().prepared_plan.label, registration: preview.ids.registration,
    decision_reference: FINANCE_DECISION_SHA256, decision_version: '0', decision_sha256: FINANCE_DECISION_SHA256,
    audit_id: 'fixture-audit', audit_metadata: '{}' };
  function run(overrides = {}) {
    const supplied = { ...params, ...overrides };
    const sql = preview.sql.replace(/`fixture-project\.fixture_dataset\.([a-z_]+)`/g, '"$1"')
      .replaceAll('CURRENT_TIMESTAMP()', 'CURRENT_TIMESTAMP')
      .replace("CONCAT(@audit_id,'-assignment')", "(@audit_id || '-assignment')");
    let lastChanges = null;
    const bindings = statement => Object.fromEntries([...new Set(statement.match(/@[a-z_][a-z_0-9]*/g) || [])]
      .map(name => [name, supplied[name.slice(1)]]));
    try {
      for (const fragment of sql.split(';')) {
        const statement = fragment.trim();
        if (!statement) continue;
        const check = /^ASSERT\s+([\s\S]+?)\s+AS\s+'([^']+)'$/i.exec(statement);
        if (check) {
          const pass = check[1] === '@@row_count=1' ? lastChanges === 1 :
            db.prepare(`SELECT ${check[1]} AS ok`).get(bindings(check[1])).ok === 1;
          if (!pass) throw new Error(check[2]);
        } else if (/^(BEGIN|COMMIT) TRANSACTION$/i.test(statement)) {
          db.exec(statement);
        } else {
          lastChanges = Number(db.prepare(statement).run(bindings(statement)).changes);
        }
      }
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  return { db, run };
}

test('registration rejects altered or missing approved scope before any write', () => {
  const changes = [
    { plan_id: 'other-plan' }, { assignment_id: 'other-assignment' }, { plan_source: 'other-source' },
    { assignment_source: 'other-source' }, { registration: 'other-registration' }, { label: 'Other plan' },
    { decision_reference: 'a'.repeat(64) }, { decision_sha256: 'a'.repeat(64) },
    { decision_version: '1' }, { decision_reference: null }
  ];
  for (const change of changes) {
    const { db, run } = createLocalRegistrationFixture();
    try {
      assert.throws(() => run(change), /FINANCE_REGISTRATION_SCOPE_MISMATCH/);
      assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 5);
      for (const table of ['management_operational_plans', 'management_operational_assignments', 'administration_audit_log']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      }
    } finally { db.close(); }
  }
});

test('initial registration does not depend on unrelated GED intent history', () => {
  for (const withClosure of [false, true]) {
    const { db, run } = createLocalRegistrationFixture();
    try {
      db.prepare("INSERT INTO administration_audit_log (id, tenant_id, entity_type, entity_id, action) VALUES (?, '2sg', 'finance_ged_intent', ?, 'prepared')")
        .run('fixture-intent', FINANCE_DECISION_SHA256);
      if (withClosure) db.prepare("INSERT INTO administration_audit_log (id, tenant_id, entity_type, entity_id, action) VALUES (?, '2sg', 'finance_ged_intent', ?, 'closed')")
        .run('fixture-intent-closed', FINANCE_DECISION_SHA256);
      run();
      assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 6);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM management_operational_plans').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM management_operational_assignments').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM administration_audit_log').get().n, withClosure ? 4 : 3);
    } finally { db.close(); }
  }
});

test('a changed registry revision blocks stale registration even with unrelated GED intent', () => {
  const { db, run } = createLocalRegistrationFixture();
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('UPDATE administration_task_registry_state SET revision=6 WHERE id=\'registry\' AND revision=5');
    db.prepare("INSERT INTO administration_audit_log (id, tenant_id, entity_type, entity_id, action) VALUES ('fixture-intent', '2sg', 'finance_ged_intent', ?, 'prepared')")
      .run(FINANCE_DECISION_SHA256);
    db.exec('COMMIT TRANSACTION');
    assert.throws(() => run(), /FINANCE_REGISTRY_UNAVAILABLE/);
    run({ finance_observed_revision: 6 });
    assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 7);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM management_operational_plans').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM management_operational_assignments').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM administration_audit_log').get().n, 3);
  } finally { db.close(); }
});

test('locally translated registration creates plan, assignment and two audits together and rejects replay', () => {
  const { db, run } = createLocalRegistrationFixture();
  try {
    run();
    assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 6);
    for (const table of ['management_operational_plans', 'management_operational_assignments']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM administration_audit_log').get().n, 2);
    assert.throws(() => run({ finance_observed_revision: 6 }), /FINANCE_PLAN_DUPLICATE/);
    assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 6);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM administration_audit_log').get().n, 2);
  } finally { db.close(); }
});

test('locally registered finance plan is usable by the native bridge and stops after deactivation', async () => {
  const { createFinancialReferenceBridgeCandidate, createFinancialSourceForActorCandidate } = require('../taskFinancialReferenceBridgeCandidate');
  const { PERMISSIONS, ADMINISTRATION_TABLE_CONTRACTS } = require('../administrationRegistries');
  const { db, run } = createLocalRegistrationFixture();
  try {
    run();
    const design = buildFinancialStoragePlanCandidate();
    const ids = buildFinancialRegistrationPreview().ids;
    const contracts = Object.fromEntries(design.tables.map(t => [t.candidate_name, t]));
    contracts.administration_correspondence = ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence;
    const bigquery = {
      dataset: () => ({ table: name => ({ getMetadata: async () => { const c = contracts[name];
        return [{ type: 'TABLE', schema: { fields: c.fields }, clustering: { fields: c.clustering },
          ...(c.partitionField ? { timePartitioning: { type: 'DAY', field: c.partitionField } } : {}) }]; } }) }),
      query: async ({ query, params }) => {
        if (query.includes('.management_operational_plans`')) return [db.prepare(
          'SELECT * FROM management_operational_plans WHERE tenant_id=? AND source_key=? LIMIT 2').all(params.tenant, params.source)];
        if (query.includes('.management_operational_assignments`')) return [db.prepare(
          'SELECT * FROM management_operational_assignments WHERE tenant_id=? AND operational_plan_id=? AND actor_user_id=? LIMIT 2')
          .all(params.tenant, params.plan, params.actor)];
        if (query.includes('.management_portfolios`')) return [db.prepare(
          'SELECT tenant_id,portfolio_id,function_id,status,confidentiality,source_ref FROM management_portfolios WHERE tenant_id=? AND portfolio_id=? LIMIT 2')
          .all(params.tenant, params.portfolio)];
        if (query.includes('.administration_correspondence`')) {
          const rows = db.prepare('SELECT * FROM administration_correspondence WHERE tenant_id=? AND id=? LIMIT 2').all(params.tenant, params.id);
          return [rows.map(row => ({ ...row, not_deleted: row.deleted_at === null }))];
        }
        throw Error('unexpected fixture query');
      }
    };
    let documentCalls = 0;
    const sourceForActor = createFinancialSourceForActorCandidate({ bigquery, projectId: 'fixture-project', datasetId: 'fixture_dataset',
      getGedServices: async () => { documentCalls++; throw Error('unexpected document access'); },
      canReadFinance: async () => true, loadPerson: async () => ({ id: 'PER-2SG-0001', team_id: 'TZH', label: 'Synthetic Person', active: true }) });
    const base = { inspectForActor: async () => ({ writes_enabled: false, choices: { phases: [], activities: [],
      operational_plans: [], assignments: [], recurrences: [] } }), bindForActor: async () => null };
    const bridge = createFinancialReferenceBridgeCandidate({ standardSource: base, enabled: true, financialSourceForActor: sourceForActor });
    const actor = { tenantId: '2sg', actorId: 'fixture-user', principal: { id: 'fixture-user', tenantId: '2sg', authProvider: 'google' },
      permissions: [PERMISSIONS.RESOURCES_READ, PERMISSIONS.RESOURCES_WRITE, PERMISSIONS.CORRESPONDENCE_READ] };
    const bound = await bridge.bindForActor(actor);
    assert.ok(bound);
    assert.equal((await bound.catalogue.get('operational_plan', ids.plan, '2sg')).id, ids.plan);
    assert.equal(bound.financialWriteGuard.assignmentSourceKey, ids.assignmentSource);
    db.prepare("UPDATE management_operational_plans SET status='inactive' WHERE id=?").run(ids.plan);
    assert.equal(await bound.catalogue.get('operational_plan', ids.plan, '2sg'), null);
    assert.equal(await bridge.bindForActor(actor), null);
    assert.equal(documentCalls, 0);
  } finally { db.close(); }
});

test('prepared registration command binds the exact plan and auditable approval without executing', () => {
  const { buildFinancialRegistrationCommand } = require('../taskFinancialRegistrationCommand');
  const { db, run } = createLocalRegistrationFixture();
  try {
    const command = buildFinancialRegistrationCommand({ actorId: 'fixture-user', observedRevision: 5,
      auditId: 'fixture-audit', target: { project: 'fixture-project', dataset: 'fixture_dataset' } });
    assert.equal(command.status, 'prepared_only');
    assert.equal(command.executable, false);
    assert.equal(command.types.finance_observed_revision, 'INT64');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM management_operational_plans').get().n, 0);
    assert.ok(command.pending.includes('qualify_zero_additional_cost'));
    const names = [...new Set([...command.sql.matchAll(/(?<!@)@([a-z_][a-z_0-9]*)/g)].map(m => m[1]))].sort();
    assert.deepEqual(Object.keys(command.params).sort(), names);
    assert.deepEqual(Object.keys(command.types).sort(), names);
    const metadata = JSON.parse(command.params.audit_metadata);
    assert.deepEqual(metadata.approval_messages, buildFinancialStoragePlanCandidate().existing_evidence.validation_messages);
    assert.equal(metadata.consultation_reference, 'COR-de403d44-4f7d-4926-ba0d-f3ac6e20687f');
    run(command.params);
    const rows = db.prepare('SELECT metadata_json FROM administration_audit_log ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.metadata_json === command.params.audit_metadata));
  } finally { db.close(); }
  for (const input of [ {}, { actorId: 'x', observedRevision: -1, auditId: 'ok' },
    { actorId: 'x', observedRevision: 1.5, auditId: 'ok' },
    { actorId: ' x', observedRevision: 1, auditId: 'ok' },
    { actorId: 'x', observedRevision: 1, auditId: 'bad\naudit' } ]) {
    assert.throws(() => buildFinancialRegistrationCommand(input), /FINANCE_REGISTRATION_INPUT_INVALID/);
  }
});

test('locally translated registration rolls back everything if the final audit fails', () => {
  const { db, run } = createLocalRegistrationFixture();
  try {
    db.exec("CREATE TRIGGER reject_assignment_audit BEFORE INSERT ON administration_audit_log WHEN NEW.entity_type='operational_assignment' BEGIN SELECT RAISE(ABORT, 'fixture-audit-failure'); END");
    assert.throws(() => run(), /fixture-audit-failure/);
    assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 5);
    for (const table of ['management_operational_plans', 'management_operational_assignments', 'administration_audit_log']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
  } finally { db.close(); }
});

test('registration rejects either existing audit identifier without changing plan, assignment or fence', () => {
  for (const existingId of ['fixture-audit', 'fixture-audit-assignment']) {
    const { db, run } = createLocalRegistrationFixture();
    try {
      db.prepare('INSERT INTO administration_audit_log (id, tenant_id) VALUES (?, ?)').run(existingId, '2sg');
      assert.throws(() => run(), /FINANCE_AUDIT_DUPLICATE/);
      assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 5);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM management_operational_plans').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM management_operational_assignments').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM administration_audit_log').get().n, 1);
    } finally { db.close(); }
  }
});

test('registration rejects a portfolio without the source reference required by the reader', () => {
  for (const source of [null, '', '   ']) {
    const { db, run } = createLocalRegistrationFixture();
    try {
      db.prepare('UPDATE management_portfolios SET source_ref=?').run(source);
      assert.throws(() => run(), /FINANCE_PORTFOLIO_CHANGED/);
      assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 5);
      for (const table of ['management_operational_plans', 'management_operational_assignments', 'administration_audit_log']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      }
    } finally { db.close(); }
  }
});

test('registration rejects ambiguous portfolio or correspondence identifiers required by the reader', () => {
  const duplicates = [
    ["INSERT INTO management_portfolios VALUES ('2sg','PORT-2SG-GLOBAL','management_governance','inactive','internal','other')", /FINANCE_PORTFOLIO_CHANGED/],
    ["INSERT INTO administration_correspondence VALUES ('2sg','COR-88832bd5-2231-42f3-a7d6-4f4e13a8cbe3','internal','deleted','internal','closed')", /FINANCE_SOURCE_UNAVAILABLE/]
  ];
  for (const [duplicate, expected] of duplicates) {
    const { db, run } = createLocalRegistrationFixture();
    try {
      db.exec(duplicate);
      assert.throws(() => run(), expected);
      assert.equal(db.prepare('SELECT revision FROM administration_task_registry_state').get().revision, 5);
      for (const table of ['management_operational_plans', 'management_operational_assignments', 'administration_audit_log']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      }
    } finally { db.close(); }
  }
});

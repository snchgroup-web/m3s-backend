'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFinancialStoragePlanCandidate, buildFinancialSchemaPreview, buildFinancialRegistrationPreview } = require('../taskFinancialStoragePlanCandidate');

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
  assert.equal(plan.existing_evidence.local_excerpt_sha256.length, 64);
  assert.equal(plan.existing_evidence.server_verifier_connected, false);
  assert.equal(plan.concurrency_candidate.prevents_external_append, false);
  assert.equal(plan.concurrency_candidate.verified_in_production, false);
  assert.ok(plan.gates.includes('separate_approval_for_creation_and_activation'));
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
  assert.match(p.sql, /id='registry' AND revision>=0 AND contract_version=@contract_version/);
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
  assert.ok(p.pending.includes('server_authority_and_ged_verified'));
  assert.ok(p.pending.includes('concurrency_review_external_writers'));
});

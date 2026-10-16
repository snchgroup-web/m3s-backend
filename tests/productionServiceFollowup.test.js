const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createManagementPortfolioHandlers } = require('../managementPortfolio');
const user = { tenantId: 'test-organisation', permissions: ['administration:resources:read'] };
const source = (id = 'GD-008') => ({
  tenant_id: user.tenantId, portfolio_id: 'PORT-2SG-GLOBAL', confidentiality: 'internal',
  dossier_id: id, dossier_type: id === 'GD-008' ? 'rh_proximity_framework' : 'document_governance',
  display_title: 'Synthetic internal source', status: 'active', responsible_status: 'to_confirm',
  verified_on: { value: '2026-10-14' }, display_state: 'Documented state',
  display_next_action: 'Next documented action', source_ref: 'Synthetic source',
  employee_name: 'MUST NOT BE RETURNED', salary: 99999, evidence_ged_ref: 'PRIVATE'
});
async function invoke({ currentUser = user, rows = [source()], error = null } = {}) {
  const calls = [], result = { status: 200, headers: {} };
  const bigquery = { query: async options => { calls.push(options); if (error) throw error; return [rows]; } };
  const handlers = createManagementPortfolioHandlers({ bigquery, projectId: 'test-project', datasetId: 'test_dataset', logger: { error() {} } });
  const res = { set(k, v) { result.headers[k] = v; return this; }, status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; } };
  await handlers.getServiceFollowup({ user: currentUser }, res);
  return { ...result, calls };
}
test('requires authentication and existing metadata-read permission before querying', async () => {
  for (const [currentUser, expected] of [[null, 401], [{ tenantId: user.tenantId }, 403], [{ ...user, permissions: ['administration:resources:write'] }, 403]]) {
    const result = await invoke({ currentUser });
    assert.equal(result.status, expected);
    assert.equal(result.calls.length, 0);
    assert.equal(result.headers['Cache-Control'], 'private, no-store');
  }
});
test('reads bounded tenant-scoped metadata without mutations or sensitive fields', async () => {
  const result = await invoke();
  assert.equal(result.status, 200);
  assert.equal(result.calls.length, 1);
  const call = result.calls[0];
  assert.match(call.query, /^SELECT /);
  assert.match(call.query, /tenant_id=@tenant_id/);
  assert.match(call.query, /confidentiality='internal'/);
  assert.match(call.query, /record_status='validated_for_integration'/);
  assert.match(call.query, /LIMIT 5/);
  assert.equal(call.params.tenant_id, user.tenantId);
  assert.deepEqual(call.params.dossier_ids, ['GD-005', 'GD-006', 'GD-008', 'GD-009']);
  assert.equal(result.body.data[0].verified_on, '2026-10-14');
  assert.equal(result.body.source.read_only, true);
  assert.equal(result.body.source.scope, 'internal_service_preparation');
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE|99999|MUST NOT|tenant_id|portfolio_id|employee_name|salary/);
});
test('preserves an empty source as an empty list, not invented jobs', async () => {
  const result = await invoke({ rows: [] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, []);
});
for (const [label, patch] of [
  ['another tenant', { tenant_id: 'other' }], ['restricted', { confidentiality: 'restricted' }],
  ['unrelated dossier', { dossier_id: 'GD-002' }], ['wrong type', { dossier_type: 'employee' }],
  ['invalid date', { verified_on: '2026-02-30' }], ['missing state', { display_state: null }]
]) test(`rejects ${label} without leaking the row`, async () => {
  const result = await invoke({ rows: [{ ...source(), ...patch }] });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'SERVICE_FOLLOWUP_SOURCE_INVALID');
  assert.equal(result.body.data, undefined);
});
test('rejects duplicates instead of multiplying source counts', async () => {
  const result = await invoke({ rows: [source(), source()] });
  assert.equal(result.status, 503);
});
test('distinguishes unavailable source from a real empty list', async () => {
  for (const message of ['Not found: Table x', 'permission denied secret-detail']) {
    const result = await invoke({ error: new Error(message) });
    assert.equal(result.status, 503);
    assert.equal(result.body.data, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /secret-detail/);
  }
});
test('registers only an authenticated GET route', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/production\/service-followup', authenticateRequest, managementPortfolioHandlers\.getServiceFollowup\)/);
  assert.doesNotMatch(server, /app\.(?:post|put|patch|delete)\('\/api\/production\/service-followup/);
});

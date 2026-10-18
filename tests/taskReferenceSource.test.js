const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskReferenceSource } = require('../taskReferenceSource');
const { createTaskRegistryHandlers } = require('../taskRegistry');
const { PERMISSIONS } = require('../administrationRegistries');
const actor = () => ({ tenantId: '2sg', actorId: 'test-user', role: 'Admin', permissions: [PERMISSIONS.RESOURCES_READ] });
const row = () => ({ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL', dossier_id: 'GD-006',
  dossier_type: 'document_governance', display_title: 'Dossier test', confidentiality: 'internal',
  status: 'active', record_status: 'validated_for_integration', source_ref: 'TEST-REF', verified_on: '2026-10-18' });
const directory = () => ({ schema_version: 'rh001-directory-v1', classification: 'C2', status: 'validated_documentary',
  approved_by: 'Test', approved_on: '2026-10-18', records: [{ person_id: 'PER-2SG-9999', display_name: 'Membre test',
    preferred_name: 'Test', member_type: 'Associe', team: 'TSN', subgroup: null, position: 'Fonction documentaire test', active: true }] });
function setup({ rows = [row()], throws = false, directoryEnabled = true, doc = directory() } = {}) {
  const queries = [], reads = [];
  const source = createTaskReferenceSource({ bigquery: { query: async q => {
    queries.push(q); if (throws) throw Error('private cloud detail'); return [rows];
  } }, projectId: 'test-project', datasetId: 'test_dataset', directoryEnabled,
  directoryAllowedRoles: new Set(['Admin']), readDirectory: async p => { reads.push(p); return doc; }, directoryPath: 'test-directory' });
  return { source, queries, reads };
}

test('uses existing scoped documentary sources without promoting phases or assignment permissions', async () => {
  const f = setup();
  const result = await f.source.inspectForActor(actor());
  assert.equal(result.sources.dossiers.status, 'available');
  assert.equal(result.sources.members.data[0].id, 'PER-2SG-9999');
  assert.equal(result.sources.members.data[0].team_id, 'TSN');
  assert.equal(result.sources.members.data[0].function_id, undefined);
  assert.equal(result.writes_enabled, false);
  assert.equal(result.execution_catalogue_ready, false);
  assert.equal(await f.source.bindForActor(actor()), null);
  assert.ok(Object.values(result.choices).every(v => v.length === 0));
  const q = f.queries[0];
  assert.match(q.query, /tenant_id=@tenant_id/);
  assert.match(q.query, /confidentiality='internal'/);
  assert.match(q.query, /record_status='validated_for_integration'/);
  assert.deepEqual(q.params.dossier_ids, ['GD-005', 'GD-006', 'GD-008', 'GD-009']);
  assert.doesNotMatch(q.query, /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|GRANT)\b/);
});

test('missing explicit resource permission prevents all source reads even with Admin role', async () => {
  const f = setup();
  await assert.rejects(f.source.inspectForActor({ ...actor(), permissions: [] }), { code: 'TASK_FORBIDDEN' });
  assert.equal(f.queries.length, 0); assert.equal(f.reads.length, 0);
});

test('directory retains its existing feature, role and institutional scope gates', async () => {
  for (const [options, patch] of [[{ directoryEnabled: false }, {}], [{}, { role: 'Utilisateur' }], [{}, { tenantId: 'foreign' }]]) {
    const f = setup(options);
    const r = await f.source.inspectForActor({ ...actor(), ...patch });
    assert.equal(r.sources.members.status, 'forbidden');
    assert.equal(f.reads.length, 0);
  }
});

test('duplicate, foreign, restricted or unqualified dossier rows fail closed without erasing the other source', async () => {
  for (const rows of [[row(), row()], [{ ...row(), tenant_id: 'foreign' }], [{ ...row(), confidentiality: 'restricted' }],
    [{ ...row(), record_status: 'candidate' }], [{ ...row(), verified_on: '2026-02-30' }]]) {
    const f = setup({ rows });
    const r = await f.source.inspectForActor(actor());
    assert.equal(r.sources.dossiers.status, 'unavailable');
    assert.equal(r.sources.members.status, 'available');
    assert.deepEqual(r.sources.dossiers.data, []);
  }
});

test('empty available catalogue differs from failed read and never enables writes', async () => {
  const empty = await setup({ rows: [] }).source.inspectForActor(actor());
  const failed = await setup({ throws: true }).source.inspectForActor(actor());
  assert.equal(empty.sources.dossiers.status, 'available');
  assert.equal(failed.sources.dossiers.status, 'unavailable');
  assert.equal(JSON.stringify(failed).includes('private cloud'), false);
  assert.equal(failed.writes_enabled, false);
});

test('invalid directory never becomes an executable assignment or leaks extra fields', async () => {
  const r = await setup({ doc: { ...directory(), email: 'private@test.invalid' } }).source.inspectForActor(actor());
  assert.equal(r.sources.members.status, 'unavailable');
  assert.equal(JSON.stringify(r).includes('private@test.invalid'), false);
});

test('new reference route authenticates and retains no-store and source version guards', async () => {
  const source = setup().source;
  const handlers = createTaskRegistryHandlers({ bigquery: {}, projectId: 'test-project', datasetId: 'test_dataset', referenceSource: source, logger: { warn() {} } });
  const res = () => ({ statusCode: 200, set(k, v) { this[k] = v; }, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; } });
  const denied = res(); await handlers.references({ user: null }, denied);
  assert.equal(denied.statusCode, 401);
  const ok = res(); await handlers.references({ user: { id: 'test-user', tenantId: '2sg', role: 'Admin', permissions: actor().permissions } }, ok);
  assert.equal(ok.body.contract_version, 'm3s.task-execution.v2');
  assert.equal(ok['Cache-Control'], 'no-store');
  assert.equal(ok.body.writes_enabled, false);
});

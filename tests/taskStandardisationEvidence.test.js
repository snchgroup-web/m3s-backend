const test = require('node:test');
const assert = require('node:assert/strict');
const { createStandardisationEvidenceQualifier, I18N_CORRESPONDENCE_ID } = require('../taskStandardisationEvidence');
const { ADMINISTRATION_TABLE_CONTRACTS, PERMISSIONS } = require('../administrationRegistries');
const { buildTaskActivationSchemaProposal } = require('../taskRegistry');

function fixture(change = () => {}) {
  const c = ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence;
  const state = { metadata: { type: 'TABLE', schema: { fields: c.fields },
    timePartitioning: { type: 'DAY', field: c.partitionField }, clustering: { fields: c.clustering } },
    rows: [{ id: I18N_CORRESPONDENCE_ID, tenant_id: '2sg', confidentiality: 'internal', direction: 'internal',
      status: 'in_progress', not_deleted: true }] };
  change(state);
  const queries = [], metadataReads = [];
  const q = createStandardisationEvidenceQualifier({ projectId: 'test-project', datasetId: 'test_dataset',
    bigquery: { dataset: () => ({ table: n => ({ getMetadata: async () => {
      metadataReads.push(n); if (!state.metadata) throw Error('private metadata detail'); return [state.metadata];
    } }) }), query: async x => { queries.push(x); if (state.throw) throw Error('private query detail'); return [structuredClone(state.rows)]; } } });
  const actor = { tenantId: '2sg', actorId: 'actor-test', executionProjectId: 'project-test',
    permissions: [PERMISSIONS.RESOURCES_READ, PERMISSIONS.CORRESPONDENCE_READ] };
  const input = () => ({ source_origin: { kind: 'correspondence', reference: I18N_CORRESPONDENCE_ID },
    source_links: [], context: { execution_kind: 'project', project_id: 'project-test' } });
  return { q, actor, input, queries, metadataReads, state };
}

test('qualifies only the existing I18N Agenda source through its correspondence identity', async () => {
  const f = fixture(), bound = await f.q.bindForActor(f.actor);
  assert(bound); assert.equal(await bound.qualifySources(f.input()), true);
  assert.equal(f.queries.length, 2);
  for (const q of f.queries) {
    assert.match(q.query, /tenant_id=@tenant_id AND id=@source_id AND deleted_at IS NULL/);
    assert.match(q.query, /confidentiality IN \('public','internal'\)/);
    assert.doesNotMatch(q.query, /\b(subject|sender|recipient|INSERT|UPDATE|DELETE|MERGE|GRANT)\b/);
    assert.equal(q.params.source_id, I18N_CORRESPONDENCE_ID); assert.equal(q.maximumBytesBilled, '10485760');
  }
});

test('explicit permissions and authenticated identity are required before any source read', async () => {
  for (const patch of [{ tenantId: 'foreign' }, { actorId: '' }, { executionProjectId: null },
    { permissions: [] }, { permissions: [PERMISSIONS.RESOURCES_READ] },
    { permissions: [PERMISSIONS.CORRESPONDENCE_READ] }]) {
    const f = fixture(); assert.equal(await f.q.bindForActor({ ...f.actor, ...patch, role: 'Manager' }), null);
    assert.equal(f.queries.length, 0); assert.equal(f.metadataReads.length, 0);
  }
});

test('absent, foreign, duplicate, deleted or restricted source never qualifies', async () => {
  for (const change of [s => { s.rows = []; }, s => { s.rows.push({ ...s.rows[0] }); },
    s => { s.rows[0].tenant_id = 'foreign'; }, s => { s.rows[0].confidentiality = 'restricted_hr'; },
    s => { s.rows[0].confidentiality = 'confidential'; }, s => { s.rows[0].not_deleted = false; },
    s => { s.rows[0].direction = 'outgoing'; }, s => { s.rows[0].id = 'COR-other'; }, s => { s.throw = true; }]) {
    const f = fixture(change); assert.equal(await f.q.bindForActor(f.actor), null);
  }
});

test('source metadata must be the existing compatible durable table, not a view', async () => {
  for (const change of [s => { s.metadata = null; }, s => { s.metadata.type = 'VIEW'; },
    s => { s.metadata.expirationTime = '123'; }, s => { s.metadata.timePartitioning.expirationMs = '123'; },
    s => { s.metadata.schema = { fields: [] }; }]) {
    const f = fixture(change); assert.equal(await f.q.bindForActor(f.actor), null); assert.equal(f.queries.length, 0);
  }
});

test('unknown kinds, missing origins and duplicate evidence are refused without fetching them', async () => {
  for (const patch of [{ source_origin: null }, { source_origin: { kind: 'ged', reference: 'GED-test' } },
    { source_origin: { kind: 'correspondence', reference: 'COR-unknown' } },
    { source_links: [{ kind: 'journal', reference: 'file:///private' }] },
    { source_links: [{ kind: 'correspondence', reference: I18N_CORRESPONDENCE_ID }, { kind: 'correspondence', reference: I18N_CORRESPONDENCE_ID }] }]) {
    const f = fixture(), bound = await f.q.bindForActor(f.actor);
    assert.equal(await bound.qualifySources({ ...f.input(), ...patch }), false); assert.equal(f.queries.length, 1);
  }
});

test('a qualified source is bound to the resolved project, not a client-supplied foreign context', async () => {
  const f = fixture(), bound = await f.q.bindForActor(f.actor);
  for (const context of [null, { execution_kind: 'operation', project_id: 'project-test' },
    { execution_kind: 'project', project_id: 'other' }]) {
    assert.equal(await bound.qualifySources({ ...f.input(), context }), false);
  }
  assert.equal(f.queries.length, 1);
});

test('rechecks source visibility at mutation time without interpreting closed correspondence as task completion', async () => {
  const f = fixture(), bound = await f.q.bindForActor(f.actor);
  f.state.rows[0].status = 'closed'; assert.equal(await bound.qualifySources(f.input()), true);
  f.state.rows[0].not_deleted = false; assert.equal(await bound.qualifySources(f.input()), false);
  assert.equal(f.queries.length, 3);
});

test('schema review proposes only five new tables and cannot execute or alter existing data', () => {
  const p = buildTaskActivationSchemaProposal({ projectId: 'test-project', datasetId: 'test_dataset' });
  assert.equal(p.application_allowed, false); assert.equal(p.cloud_access, false);
  assert.equal(p.tables.length, 5); assert.equal(p.proposed_statements.length, 5);
  assert.equal(p.required_existing_table, 'administration_audit_log');
  for (const sql of p.proposed_statements) {
    assert.match(sql, /^CREATE TABLE `test-project.test_dataset\./);
    assert.doesNotMatch(sql, /\b(DROP|ALTER|DELETE|TRUNCATE|MERGE|INSERT|GRANT)\b|IF NOT EXISTS/);
  }
  assert.throws(() => buildTaskActivationSchemaProposal({ projectId: 'bad`project', datasetId: 'test_dataset' }));
});

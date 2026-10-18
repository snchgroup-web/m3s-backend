const test = require('node:test');
const assert = require('node:assert/strict');
const { createStandardisationReferenceReader, buildStandardisationRegistrationPreparation,
  STANDARDISATION_TABLE_CONTRACTS, DECISION_SHA256 } = require('../taskStandardisationReferences');
const { resolveTaskExecutionContext } = require('../taskExecutionContract');
const { createTaskReferenceSource } = require('../taskReferenceSource');
const { PERMISSIONS, ADMINISTRATION_TABLE_CONTRACTS } = require('../administrationRegistries');
const { I18N_CORRESPONDENCE_ID } = require('../taskStandardisationEvidence');

function fixture(edit = () => {}) {
  const plan = buildStandardisationRegistrationPreparation();
  const registered = (r, id) => ({ ...r, id, governance_status: 'approved', status: 'active', registration_reference: 'REG-TEST-001' });
  const data = { project: [registered(plan.project, 'project-test')],
    phases: plan.phases.map((p, i) => ({ ...registered(p, `phase-test-${i + 1}`), project_id: 'project-test' })),
    assignments: [{ ...registered(plan.assignment, 'assignment-test'), project_id: 'project-test', actor_user_id: 'test-user' }],
    portfolio: [{ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL', function_id: 'management_governance',
      status: 'active', confidentiality: 'internal' }],
    dossiers: [{ tenant_id: '2sg', portfolio_id: 'PORT-2SG-GLOBAL', dossier_id: 'GD-006', dossier_type: 'document_governance',
      display_title: 'Dossier test', confidentiality: 'internal', status: 'active', record_status: 'validated_for_integration',
      source_ref: 'TEST-REF', verified_on: '2026-10-18' }],
    metadata: Object.fromEntries(Object.entries(STANDARDISATION_TABLE_CONTRACTS).map(([n, c]) => [n,
      { type: 'TABLE', schema: { fields: structuredClone(c.fields) }, clustering: { fields: c.clustering } }])) };
  const correspondence = ADMINISTRATION_TABLE_CONTRACTS.administration_correspondence;
  data.metadata.administration_correspondence = { type: 'TABLE', schema: { fields: correspondence.fields },
    timePartitioning: { type: 'DAY', field: correspondence.partitionField }, clustering: { fields: correspondence.clustering } };
  data.evidence = [{ id: I18N_CORRESPONDENCE_ID, tenant_id: '2sg', confidentiality: 'internal', direction: 'internal',
    status: 'in_progress', not_deleted: true }];
  edit(data);
  const queries = [], metadataReads = [];
  const bigquery = { dataset: () => ({ table: n => ({ getMetadata: async () => {
    metadataReads.push(n); if (!data.metadata[n]) throw Error('private connection details'); return [data.metadata[n]];
  } }) }), query: async q => {
    queries.push(q);
    const key = [['management_projects', 'project'], ['management_project_phases', 'phases'],
      ['management_task_assignments', 'assignments'], ['management_portfolios', 'portfolio'], ['management_dossiers', 'dossiers'],
      ['administration_correspondence', 'evidence']]
      .find(([name]) => q.query.includes(`.${name}\``))?.[1];
    if (!key) throw Error('Unexpected query');
    return [structuredClone(data[key])];
  } };
  const actor = { tenantId: '2sg', actorId: 'test-user', permissions: [PERMISSIONS.RESOURCES_READ],
    dossiers: { status: 'available', data: [{ id: 'GD-006', portfolio_id: 'PORT-2SG-GLOBAL', status: 'active' }] },
    members: { status: 'available', data: [{ id: 'PER-2SG-0001', label: 'Cheikh Ndiaye', team_id: 'TZH' }] } };
  const reader = createStandardisationReferenceReader({ bigquery, projectId: 'test-project', datasetId: 'test_dataset' });
  return { reader, actor, data, queries, metadataReads, bigquery };
}

test('registration preparation reuses approved scope without native IDs, DDL or active grants', () => {
  const p = buildStandardisationRegistrationPreparation();
  assert.equal(p.application_allowed, false); assert.deepEqual(p.statements, []);
  assert.equal(p.project.id, null); assert.equal(p.project.dossier_id, 'GD-006');
  assert.equal(p.phases.length, 4); assert(p.phases.every(r => r.id === null && r.project_id === null));
  assert.equal(p.assignment.actor_user_id, null); assert.equal(p.assignment.id, null);
  assert.equal(p.assignment.assignee_agent_id, 'PER-2SG-0001'); assert.equal(p.assignment.team_id, 'TZH');
  assert.equal(p.assignment.status, 'inactive'); assert.equal(p.assignment.governance_status, 'prepared_not_registered');
  assert.equal(p.assignment.approval_sha256, DECISION_SHA256);
});

test('reads the exact registered project, four phases and actor-bound assignment, never title-matching', async () => {
  const f = fixture(); const r = await f.reader.readForActor(f.actor);
  assert.equal(r.status, 'available'); assert.equal(r.scope, 'standardisation_project_only');
  assert.deepEqual(r.choices.phases.map(p => p.id), ['phase-test-1', 'phase-test-2', 'phase-test-3', 'phase-test-4']);
  assert.equal(r.choices.assignments[0].assignee_agent_id, 'PER-2SG-0001');
  assert.equal(r.choices.assignments[0].function_id, 'management_governance');
  assert.deepEqual(r.choices.operational_plans, []); assert.deepEqual(r.choices.recurrences, []);
  assert.equal(f.queries.length, 4); assert.equal(f.metadataReads.length, 3);
  for (const q of f.queries) {
    assert.match(q.query, /tenant_id=@tenant_id/);
    assert.doesNotMatch(q.query, /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|GRANT)\b/);
    assert(q.maximumBytesBilled); assert.equal(q.params.tenant_id, '2sg');
  }
  assert.match(f.queries[0].query, /source_key=@project_source/);
  assert.doesNotMatch(f.queries[0].query, /label\s*=/);
  assert.match(f.queries[2].query, /actor_user_id=@actor_user_id/);
  assert.equal(f.queries[2].params.actor_user_id, 'test-user');
});

test('canonical project context resolves only inside the checked project and tenant', async () => {
  const f = fixture(), r = await f.reader.readForActor(f.actor);
  const input = { execution_kind: 'project', phase_id: 'phase-test-2' };
  const context = await resolveTaskExecutionContext(input, { tenantId: '2sg', catalogue: r.catalogue });
  assert.equal(context.project_id, 'project-test'); assert.equal(context.dossier_id, 'GD-006');
  assert.equal(context.portfolio_id, 'PORT-2SG-GLOBAL');
  assert.equal(await r.catalogue.get('project', 'project-test', 'foreign'), null);
  await assert.rejects(resolveTaskExecutionContext({ ...input, phase_id: 'foreign-phase' },
    { tenantId: '2sg', catalogue: r.catalogue }), { code: 'TASK_CONTEXT_REFERENCE_UNQUALIFIED' });
  const a = f.data.assignments[0];
  assert.equal((await r.resolveAssignment({ ...a, context })).agent_display_name, 'Cheikh Ndiaye');
  assert.equal(await r.resolveAssignment({ ...a, context: { ...context, project_id: 'foreign-project' } }), null);
  assert.equal(await r.resolveAssignment({ ...a, module: 'FINANCES', context }), null);
});

test('missing permissions, foreign tenant or forbidden directory prevent all executable reads', async () => {
  for (const change of [{ permissions: [] }, { tenantId: 'foreign' }, { actorId: '' },
    { members: { status: 'forbidden', data: [] } }]) {
    const f = fixture(); const r = await f.reader.readForActor({ ...f.actor, ...change });
    assert.equal(r.status, 'forbidden'); assert.equal(f.queries.length, 0); assert.equal(f.metadataReads.length, 0);
  }
});

test('documentary person, active dossier and original Team are necessary, not sufficient', async () => {
  for (const change of [a => { a.members.data = []; }, a => { a.members.data[0].team_id = 'TSN'; },
    a => { a.members.data[0].label = 'Different person'; }, a => { a.dossiers.data[0].status = 'inactive'; },
    a => { a.dossiers.data[0].portfolio_id = 'other'; }]) {
    const f = fixture(); change(f.actor);
    assert.equal((await f.reader.readForActor(f.actor)).status, 'unavailable');
    assert.equal(f.metadataReads.length, 0);
  }
});

test('missing, expired or incompatible native tables never promote the approved definition', async () => {
  for (const change of [d => { delete d.metadata.management_projects; },
    d => { d.metadata.management_project_phases.expirationTime = '123'; },
    d => { d.metadata.management_projects.type = 'VIEW'; },
    d => { d.metadata.management_task_assignments.schema.fields.pop(); },
    d => { d.metadata.management_projects.clustering.fields = []; }]) {
    const f = fixture(change), r = await f.reader.readForActor(f.actor);
    assert.equal(r.status, 'unavailable'); assert.equal(f.queries.length, 0);
    assert(!JSON.stringify(r).includes('private connection details'));
  }
});

test('absent, duplicate, foreign or stale-approval project registrations fail closed', async () => {
  for (const change of [d => { d.project = []; }, d => { d.project.push({ ...d.project[0] }); },
    d => { d.project[0].tenant_id = 'foreign'; }, d => { d.project[0].approval_sha256 = '0'.repeat(64); },
    d => { d.project[0].dossier_id = 'GD-005'; }, d => { d.project[0].registration_reference = null; },
    d => { d.project[0].governance_status = 'candidate'; }, d => { d.project[0].source_key = 'similar-title'; }]) {
    const f = fixture(change); assert.equal((await f.reader.readForActor(f.actor)).status, 'unavailable');
    assert.equal(f.queries.length, 1);
  }
});

test('requires exactly the four distinct, ordered phases and approved exit criteria', async () => {
  for (const change of [d => { d.phases.pop(); }, d => { d.phases.push({ ...d.phases[0] }); },
    d => { d.phases[1].id = d.phases[0].id; }, d => { d.phases[1].phase_order = 1; },
    d => { d.phases[1].project_id = 'other'; }, d => { d.phases[1].exit_criterion = 'invented'; },
    d => { d.phases[1].source_key = 'unapproved'; }, d => { d.phases[1].status = 'inactive'; }]) {
    const f = fixture(change); assert.equal((await f.reader.readForActor(f.actor)).status, 'unavailable');
  }
  const f = fixture(d => { d.phases.reverse(); });
  assert.equal((await f.reader.readForActor(f.actor)).choices.phases[0].id, 'phase-test-1');
});

test('assignment must be unique, personally bound and project-scoped; dossier AFF labels cannot substitute', async () => {
  for (const change of [d => { d.assignments = []; }, d => { d.assignments.push({ ...d.assignments[0] }); },
    d => { d.assignments[0].actor_user_id = 'other-user'; }, d => { d.assignments[0].project_id = 'other'; },
    d => { d.assignments[0].assignee_agent_id = null; }, d => { d.assignments[0].assignee_agent_id = 'AFF-GD-006-01'; },
    d => { d.assignments[0].team_id = 'TSN'; }, d => { d.assignments[0].function_id = 'administration'; },
    d => { d.assignments[0].module = 'RH'; }, d => { d.assignments[0].governance_status = 'functionally_validated'; },
    d => { d.assignments[0].registration_reference = ''; }]) {
    const f = fixture(change); assert.equal((await f.reader.readForActor(f.actor)).status, 'unavailable');
  }
});

test('portfolio remains a distinct live parent with the checked existing function', async () => {
  for (const change of [d => { d.portfolio = []; }, d => { d.portfolio.push({ ...d.portfolio[0] }); },
    d => { d.portfolio[0].tenant_id = 'foreign'; },
    d => { d.portfolio[0].status = 'inactive'; }, d => { d.portfolio[0].function_id = 'other'; },
    d => { d.portfolio[0].confidentiality = 'restricted'; }]) {
    const f = fixture(change); assert.equal((await f.reader.readForActor(f.actor)).status, 'unavailable');
  }
});

test('registered references can be inspected through the existing route, without enabling task writes', async () => {
  const f = fixture();
  const doc = { schema_version: 'rh001-directory-v1', classification: 'C2', status: 'validated_documentary',
    approved_by: 'Test', approved_on: '2026-10-18', records: [{ person_id: 'PER-2SG-0001', display_name: 'Cheikh Ndiaye',
      preferred_name: 'Cheikh', member_type: 'Fondateur', team: 'TZH', subgroup: null, position: 'Manager', active: true }] };
  const source = createTaskReferenceSource({ bigquery: f.bigquery,
  projectId: 'test-project', datasetId: 'test_dataset', directoryEnabled: true, directoryAllowedRoles: new Set(['Admin']),
  readDirectory: async () => doc });
  const actor = { tenantId: '2sg', actorId: 'test-user', permissions: [PERMISSIONS.RESOURCES_READ, PERMISSIONS.RESOURCES_WRITE], role: 'Admin' };
  const result = await source.inspectForActor(actor);
  assert.equal(result.execution_catalogue_ready, true); assert.equal(result.choices.phases.length, 4);
  assert.equal(result.writes_enabled, false); assert.deepEqual(result.missing, ['canonical_source_resolution']);
  assert.equal(await source.bindForActor(actor), null);
  assert.equal(f.queries.length, 5);
  assert(!JSON.stringify(result).includes('actor_user_id')); assert(!JSON.stringify(result).includes('registration_reference'));
});

function bindingFixture(activationEnabled, edit) {
  const f = fixture(edit);
  const doc = { schema_version: 'rh001-directory-v1', classification: 'C2', status: 'validated_documentary', approved_by: 'Test',
    approved_on: '2026-10-18', records: [{ person_id: 'PER-2SG-0001', display_name: 'Cheikh Ndiaye', preferred_name: 'Cheikh',
      member_type: 'Fondateur', team: 'TZH', subgroup: null, position: 'Manager', active: true }] };
  const source = createTaskReferenceSource({ bigquery: f.bigquery, projectId: 'test-project', datasetId: 'test_dataset',
    directoryEnabled: true, directoryAllowedRoles: new Set(['Admin']), readDirectory: async () => doc, activationEnabled });
  const actor = { tenantId: '2sg', actorId: 'test-user', role: 'Admin',
    permissions: [PERMISSIONS.RESOURCES_READ, PERMISSIONS.RESOURCES_WRITE, PERMISSIONS.CORRESPONDENCE_READ] };
  return { ...f, source, actor };
}

test('qualified references and evidence do not activate the default factory or a client-provided switch', async () => {
  const f = bindingFixture(undefined);
  const r = await f.source.inspectForActor({ ...f.actor, activationEnabled: true });
  assert.equal(r.execution_catalogue_ready, true); assert.equal(r.source_resolution_ready, true);
  assert.equal(r.activation_enabled, false); assert.equal(r.writes_enabled, false);
  assert.deepEqual(r.missing, []); assert.equal(await f.source.bindForActor(f.actor), null);
});

test('explicit hypothetical activation binds only the resolved project, assignment and existing I18N source', async () => {
  const f = bindingFixture(true), bound = await f.source.bindForActor(f.actor);
  assert(bound); assert.equal(bound.writes_enabled, true);
  const context = await resolveTaskExecutionContext({ execution_kind: 'project', phase_id: 'phase-test-1' },
    { tenantId: '2sg', catalogue: bound.catalogue });
  const assignment = f.data.assignments[0];
  assert.equal((await bound.resolveAssignment({ ...assignment, context })).assignee_agent_id, 'PER-2SG-0001');
  assert.equal(await bound.qualifySources({ source_links: [], source_origin: { kind: 'correspondence', reference: I18N_CORRESPONDENCE_ID }, context }), true);
  assert.equal(await bound.qualifySources({ source_links: [], source_origin: { kind: 'ged', reference: 'GED-other' }, context }), false);
  assert.equal(await bound.resolveAssignment({ ...assignment, context: { ...context, project_id: 'foreign' } }), null);
});

test('even an enabled factory cannot bypass the RH role, explicit write permission or source retention gate', async () => {
  for (const patch of [{ role: 'Other' }, { permissions: [PERMISSIONS.RESOURCES_READ, PERMISSIONS.CORRESPONDENCE_READ] }]) {
    const f = bindingFixture(true); assert.equal(await f.source.bindForActor({ ...f.actor, ...patch }), null);
  }
  const f = bindingFixture(true, d => { d.metadata.administration_correspondence.timePartitioning.expirationMs = '5184000000'; });
  assert.equal(await f.source.bindForActor(f.actor), null);
  assert.equal(await f.source.bindForActor(null), null);
});

test('opaque authenticated account IDs are matched exactly, never inferred from a person name or email', async () => {
  const f = fixture(d => { d.assignments[0].actor_user_id = 'opaque@example.invalid'; });
  const r = await f.reader.readForActor({ ...f.actor, actorId: 'opaque@example.invalid' });
  assert.equal(r.status, 'available');
  assert.equal((await f.reader.readForActor({ ...f.actor, actorId: 'other@example.invalid' })).status, 'unavailable');
});

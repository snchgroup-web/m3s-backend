const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskRegistryHandlers, TASK_TABLE_CONTRACTS } = require('../taskRegistry');
const { ADMINISTRATION_TABLE_CONTRACTS } = require('../administrationRegistries');
const version = 'm3s.task-execution.v2';
const user = { id: 'test-owner', tenantId: 'test-tenant', role: 'Manager', permissions: ['administration:resources:read'] };
const assignment = { assignee_agent_id: 'test-person', team_id: 'test-team', function_id: 'test-function', module: 'ADMINISTRATION' };
const row = () => ({ id: 'TASK-test', reference: 'TEST-001', contract_version: version,
  title: 'Synthetic task', status: 'in_progress', priority: 'normal', ...assignment,
  project_id: 'test-project-id', execution_kind: 'project', phase_id: 'test-phase',
  source_kind: 'operational', can_edit: false, revision: 2, source_links_json: '[]', source_origin_json: 'null' });
function setup({ items = [row()], total = items.length, ready = true, refsPatch = {} } = {}) {
  const calls = [], actors = [];
  const contracts = { ...TASK_TABLE_CONTRACTS, administration_audit_log: ADMINISTRATION_TABLE_CONTRACTS.administration_audit_log };
  const bigquery = { dataset: () => ({ table: name => ({ getMetadata: async () => {
    if (!ready) throw Error('private metadata');
    const c = contracts[name];
    return [{ schema: { fields: c.fields }, clustering: { fields: c.clustering },
      ...(c.partitionField ? { timePartitioning: { type: 'DAY', field: c.partitionField } } : {}) }];
  } }) }), query: async q => {
    calls.push(q);
    return q.query.includes("COUNTIF(id='registry'") ? [[{ total: 1, valid: 1, invalid_task_versions: 0 }]] : [[{ total, items }]];
  } };
  const referenceSource = { inspectForActor: async actor => {
    actors.push(actor);
    return { contract_version: version, execution_catalogue_ready: true,
      choices: { assignments: [assignment], phases: [{ id: 'test-phase', project_id: 'test-project-id' }] }, ...refsPatch };
  } };
  const handlers = createTaskRegistryHandlers({ bigquery, projectId: 'test-project', datasetId: 'test_data',
    historicalTenantId: 'test-tenant', referenceSource, logger: { warn() {} } });
  return { calls, actors, async call(patch = {}) {
    const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; },
      status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } };
    await handlers.mine({ user, query: { contract_version: version }, ...patch }, res);
    return res;
  } };
}
test('own tasks reuse explicit read rights, actor-bound assignment and SQL paging without history or writes', async () => {
  const f = setup({ total: 12 });
  const res = await f.call({ query: { contract_version: version, limit: '10', offset: '2', search: "one' OR TRUE" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.scope, 'current_account_assignments');
  assert.equal(res.body.read_only, true);
  assert.equal(res.body.historical_included, false);
  assert.equal(res.body.total, 12); assert.equal(res.body.count, 1);
  assert.equal(res.body.data[0].can_edit, false);
  assert.deepEqual(f.actors[0], { tenantId: user.tenantId, actorId: user.id, permissions: user.permissions, role: user.role });
  const q = f.calls.at(-1);
  assert.equal(q.params.owner_user_id, user.id); assert.equal(q.params.tenant_id, user.tenantId);
  assert.equal(q.params.assignee_agent_id, assignment.assignee_agent_id);
  assert.equal(q.params.search, "one' OR TRUE");
  assert.match(q.query, /owner_user_id=@owner_user_id/);
  assert.match(q.query, /assignee_agent_id=@assignee_agent_id AND project_id=@project_id/);
  assert.match(q.query, /LIMIT @limit OFFSET @offset/);
  assert.doesNotMatch(f.calls.map(q => q.query).join('\n'), /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|GRANT)\b|taches_propres|bdd_taches|UNION ALL/);
});
test('own tasks fail closed for missing identity, foreign tenant and missing explicit read right', async () => {
  for (const actor of [null, { ...user, id: '' }, { ...user, tenantId: 'foreign' }, { ...user, permissions: [], role: 'Admin' }]) {
    const f = setup(), res = await f.call({ user: actor });
    assert.ok([401, 403].includes(res.statusCode)); assert.equal(f.calls.length, 0);
    assert.equal(f.actors.length, 0);
  }
});
test('client cannot choose a person, tenant or owner; invalid paging is rejected before reads', async () => {
  for (const query of [{ owner_user_id: 'foreign' }, { assignee_agent_id: 'foreign' }, { tenantId: 'foreign' },
    { limit: '101' }, { offset: '-1' }, { search: ['one','two'] }, { contract_version: 'old' }]) {
    const f = setup(), res = await f.call({ query: { contract_version: version, ...query } });
    assert.equal(res.statusCode, 400); assert.equal(f.calls.length, 0);
  }
});
test('unavailable source or unqualified assignment is not an empty personal list or history fallback', async () => {
  for (const options of [{ ready: false }, { refsPatch: { execution_catalogue_ready: false } },
    { refsPatch: { choices: { assignments: [], phases: [] } } },
    { refsPatch: { choices: { assignments: [assignment, assignment], phases: [{ project_id: 'p' }] } } }]) {
    const f = setup(options), res = await f.call();
    assert.equal(res.statusCode, 503); assert.equal(res.body.data, undefined);
    assert.doesNotMatch(JSON.stringify(res.body), /private metadata/);
  }
});
test('unexpected foreign, historical, editable and duplicate source rows never leave the endpoint', async () => {
  for (const items of [[{ ...row(), assignee_agent_id: 'foreign' }], [{ ...row(), project_id: 'foreign' }],
    [{ ...row(), source_kind: 'historical' }], [{ ...row(), can_edit: true }], [row(), row()]]) {
    const res = await setup({ items }).call(); assert.equal(res.statusCode, 503); assert.equal(res.body.data, undefined);
  }
});
test('a genuine empty result remains distinct from source failure', async () => {
  const res = await setup({ items: [] }).call();
  assert.equal(res.statusCode, 200); assert.equal(res.body.total, 0); assert.deepEqual(res.body.data, []);
});
test('own tasks route is GET only and uses the existing authentication middleware', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /app\.get\('\/api\/tasks\/mine', authenticateRequest, taskRegistryHandlers\.mine\)/);
  assert.doesNotMatch(source, /app\.(post|put|delete)\('\/api\/tasks\/mine'/);
});

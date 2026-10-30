const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TASK_TABLE_CONTRACTS, buildTaskRegistrySchemaPlan, normalizeTask, createTaskRegistryHandlers } = require('../taskRegistry');
const { ADMINISTRATION_TABLE_CONTRACTS } = require('../administrationRegistries');

const VERSION = 'm3s.task-execution.v2';
const body = () => ({ contract_version: VERSION, reference: 'TEST-DOC-CYCLE-01-PREP',
  title: 'Preparation documentaire', description: null, expected_result: 'Resultat synthetique verifiable',
  verification_criterion: null, status: 'to_do', priority: 'normal', module: 'Administration',
  assignee_agent_id: 'agent-test', team_id: 'team-test', function_id: 'function-test', progression: 0,
  planned_start_date: null, due_date: null, actual_start_date: null, actual_end_date: null,
  execution_context: { execution_kind: 'project', phase_id: 'phase-test', activity_id: null,
    operational_plan_id: null, recurrence_id: null, occurrence_key: null },
  source_links: [{ kind: 'ged', reference: 'GED-TEST' }],
  source_origin: { kind: 'correspondence', reference: 'COR-TEST' } });
const user = () => ({ id: 'user-a', tenantId: 'tenant-a', role: 'Manager',
  permissions: ['administration:resources:read', 'administration:resources:write'] });
const metadata = contract => ({ schema: { fields: contract.fields },
  ...(contract.partitionField ? { timePartitioning: { type: 'DAY', field: contract.partitionField } } : {}),
  clustering: { fields: contract.clustering } });
const counts = { total: 655, completed: 566, blocked: 0, cancelled: 0, open: 89,
  historical_total: 654, operational_total: 1 };
const rowFromParams = (params, extra = {}) => {
  const { tenant_id, owner_user_id, permissions, reference_key, context_key, source_identity,
    payload_hash, audit_id, event_at, metadata_json, expected_revision, ...data } = params;
  return { ...data, reference: params.reference || body().reference, source_kind: 'operational',
    revision: expected_revision ? expected_revision + 1 : 1, can_edit: true,
    source_start_date: null, source_due_date: null, created_at: event_at, updated_at: event_at,
    replayed: false, ...extra };
};
function fixture({ missing = false, queryResult, metadataChange, withoutSource = false, finance = false,
  assignmentChange, sourceAllowed = true, sourceThrows = false, bindingChange } = {}) {
  const calls = [];
  const contracts = { ...TASK_TABLE_CONTRACTS, administration_audit_log: ADMINISTRATION_TABLE_CONTRACTS.administration_audit_log };
  const bigquery = {
    dataset: () => ({ table: name => ({ getMetadata: async () => {
      if (missing) throw new Error('not available');
      return [metadataChange ? metadataChange(metadata(contracts[name]), name) : metadata(contracts[name])];
    } }) }),
    query: async options => {
      calls.push(options);
      if (queryResult) {
        const result = queryResult(options, calls);
        if (result !== undefined) return result;
      }
      if (options.query.includes("COUNTIF(id='registry'")) return [[{ total: 1, valid: 1, invalid_task_versions: 0 }]];
      if (options.query.startsWith('SELECT revision,contract_version FROM')) return [[{ revision: 12, contract_version: VERSION }]];
      if (options.query.startsWith('SELECT id FROM (')) return [[]];
      if (options.query.includes('BEGIN TRANSACTION')) return [[rowFromParams(options.params)]];
      if (options.query.includes('ARRAY(SELECT AS STRUCT')) return [[{ total: 655,
        items: [{ id: 'old-1', title: 'historical', status: 'DONE', source_kind: 'historical', can_edit: false }] }]];
      return [[counts]];
    }
  };
  const boundActors = [], assignmentInputs = [], sourceInputs = [];
  const referenceSource = withoutSource ? undefined : { async bindForActor(actor) {
    boundActors.push(actor);
    const record = (id, values = {}) => ({ id, tenant_id: actor.tenantId,
      governance_status: 'approved', status: 'active', ...values });
    const records = {
      phase: record('phase-test', { project_id: 'project-test' }),
      project: record('project-test', { dossier_id: 'dossier-test' }),
      dossier: record('dossier-test', { portfolio_id: 'portfolio-test' }),
      portfolio: record('portfolio-test'),
      activity: record('activity-test', { phase_id: 'phase-test' }),
      operational_plan: record('plan-test', { portfolio_id: 'portfolio-test', function_id: finance ? 'finance' : 'function-test' }),
      recurrence: record('recurrence-test', { operational_plan_id: 'plan-test', cadence_validated: true,
        cadence_reference: 'synthetic-cadence-approval' })
    };
    const binding = { contract_version: VERSION, writes_enabled: true,
      catalogue: { async get(kind, id) { return records[kind]?.id === id ? records[kind] : null; },
        async resolveOccurrenceKey(_recurrence, key) { return ['2026-11', '2026-12'].includes(key) ? key : null; } },
      async resolveAssignment(input) {
        assignmentInputs.push(input);
        const assignment = { ...input, tenant_id: actor.tenantId, governance_status: 'approved',
          status: 'active', agent_display_name: 'Responsable interne' };
        return assignmentChange ? assignmentChange(assignment) : assignment;
      },
      async qualifySources(input) { sourceInputs.push(input); if (sourceThrows) throw Error('private source error'); return sourceAllowed; }
    };
    return bindingChange ? bindingChange(binding) : binding;
  } };
  const handlers = createTaskRegistryHandlers({ bigquery, projectId: 'test-project', datasetId: 'test_data', referenceSource, historicalTenantId: 'tenant-a',
    now: () => '2026-10-18T10:00:00Z', logger: { warn() {} } });
  const call = async (handler, req = {}) => {
    const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
      status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } };
    await handlers[handler]({ user: user(), query: { contract_version: VERSION }, body: body(), params: {}, ...req }, res);
    return res;
  };
  return { calls, call, boundActors, assignmentInputs, sourceInputs };
}

test('historical reads require the explicit resource permission and the historical tenant', async () => {
  for (const handler of ['list', 'count', 'references']) {
    for (const actor of [{ ...user(), permissions: [] }, { ...user(), tenantId: 'foreign' }]) {
      const f = fixture(), response = await f.call(handler, { user: actor });
      assert.equal(response.statusCode, 403); assert.equal(f.calls.length, 0);
    }
  }
});
test('obsolete schema draft emits no DDL before approved execution contract is connected', () => {
  const plan = buildTaskRegistrySchemaPlan({ projectId: 'test-project', datasetId: 'test_data' });
  assert.deepEqual(plan.tables, ['administration_tasks', 'administration_task_registry_state']);
  assert.deepEqual(plan.statements, []);
  assert.equal(plan.application_allowed, false);
  assert.equal(plan.contract_version, 'm3s.task-execution.v2');
  assert.equal(plan.code, 'TASK_MODEL_ALIGNMENT_REQUIRED');
  assert.ok(plan.pending.includes('controlled_backup_and_schema_application'));
  assert.throws(() => buildTaskRegistrySchemaPlan({ projectId: 'bad`project', datasetId: 'test' }));
});
test('strict payload rejects forged actors, invalid dates, unknown fields and numeric coercions', () => {
  assert.deepEqual(normalizeTask(body()), body());
  for (const patch of [{ owner_user_id: 'other' }, { tenant_id: 'other' }, { can_edit: true },
    { progression: '100' }, { progression: -1 }, { status: 'unknown' }, { priority: 'unknown' },
    { due_date: '2026-02-30' }, { due_date: '2026-13-01' }, { title: 'x\ny' }, { reference: '' }]) {
    assert.throws(() => normalizeTask({ ...body(), ...patch }), { code: 'TASK_INVALID' });
  }
});
test('all task handlers fail closed without an authenticated account', async () => {
  for (const handler of ['access', 'list', 'count', 'create', 'update']) {
    const f = fixture();
    const res = await f.call(handler, { user: null });
    assert.equal(res.statusCode, 401);
    assert.equal(f.calls.length, 0);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});
test('role names never grant write capability and no permission mutates configuration', async () => {
  const f = fixture();
  const actor = { ...user(), permissions: [], role: 'Admin' };
  const res = await f.call('create', { user: actor });
  assert.equal(res.statusCode, 403);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(actor.permissions, []);
});
test('missing or expiring schema disables persistence and preserves historical count coverage', async () => {
  for (const options of [{ missing: true }, { metadataChange: m => ({ ...m, expirationTime: '1' }) },
    { metadataChange: m => ({ ...m, schema: { fields: [] } }) },
    { queryResult: o => o.query.includes("COUNTIF(id='registry'") ? [[{ total: 2, valid: 1 }]] : undefined }]) {
    const f = fixture(options);
    const res = await f.call('access');
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.can_write, false);
    const count = await f.call('count');
    assert.equal(count.body.coverage, 'historical_only');
    assert.equal(count.body.operational_total, null);
    const query = f.calls.at(-1).query;
    assert.doesNotMatch(query, /FROM `test-project.test_data.administration_tasks`/);
  }
});
test('a frozen registry remains readable while task writes and editing stay disabled', async () => {
  const f = fixture({ queryResult: options => {
    if (options.query.includes("COUNTIF(id='registry'")) return [[{ total: 1,
      valid: options.query.includes('revision>=0') ? 0 : 1, invalid_task_versions: 0 }]];
  } });
  const access = await f.call('access');
  assert.equal(access.body.can_read, true);
  assert.equal(access.body.can_write, false);
  const list = await f.call('list');
  assert.equal(list.body.operational_available, true);
  assert.match(f.calls.at(-1).query, /'operational' AS source_kind,FALSE AS can_edit/);
  const count = await f.call('count');
  assert.equal(count.body.operational_available, true);
  const write = await f.call('create');
  assert.equal(write.statusCode, 503);
  assert.equal(f.calls.some(call => call.query.includes('BEGIN TRANSACTION')), false);
});
test('list is globally paged and searched in SQL, not counted from the loaded page', async () => {
  const f = fixture();
  const res = await f.call('list', { query: { limit: '10', offset: '20', search: "test' OR TRUE" } });
  assert.equal(res.body.total, 655);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.data[0].can_edit, false);
  const request = f.calls.at(-1);
  assert.match(request.query, /tenant_id=@tenant_id AND owner_user_id=@owner_user_id/);
  assert.match(request.query, /COUNT\(\*\) FROM filtered/);
  assert.match(request.query, /LIMIT @limit OFFSET @offset/);
  assert.equal(request.params.search, "test' OR TRUE");
  assert.doesNotMatch(request.query, /test' OR TRUE/);
});
test('invalid pagination cannot reach BigQuery', async () => {
  for (const query of [{ limit: '101' }, { limit: '10; DROP TABLE' }, { offset: '-1' }, { offset: 'NaN' }]) {
    const f = fixture();
    assert.equal((await f.call('list', { query })).statusCode, 400);
    assert.equal(f.calls.length, 0);
  }
});
test('counter uses the same account scope and counts all statuses without a page LIMIT', async () => {
  const f = fixture();
  const res = await f.call('count');
  assert.deepEqual(Object.fromEntries(Object.keys(counts).map(k => [k, res.body[k]])), counts);
  assert.equal(res.body.coverage, 'historical_and_current_account');
  const request = f.calls.at(-1);
  assert.match(request.query, /tenant_id=@tenant_id AND owner_user_id=@owner_user_id/);
  assert.doesNotMatch(request.query, /LIMIT/);
  assert.equal(request.params.owner_user_id, 'user-a');
});
test('source failure never becomes zero and database errors are sanitized', async () => {
  const f = fixture({ queryResult: o => {
    if (o.query.includes('WITH all_tasks')) throw new Error('credentials or SQL must not escape');
  } });
  const res = await f.call('count');
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.total, undefined);
  assert.equal(JSON.stringify(res.body).includes('credentials'), false);
});
test('legacy fallback is used only for a missing preferred historical table, not access denied', async () => {
  for (const message of ['Not found: Table test-project:test_data.taches_propres', 'Access Denied']) {
    const f = fixture({ queryResult: o => {
      if (o.query.includes('WITH all_tasks') && o.query.includes('.taches_propres`')) throw new Error(message);
    } });
    const res = await f.call('count');
    assert.equal(res.statusCode, message.startsWith('Not found') ? 200 : 503);
    assert.equal(f.calls.some(o => o.query.includes('.bdd_taches`')), message.startsWith('Not found'));
  }
});
test('create derives a stable tenant reference id, serializes writers and inserts audit atomically', async () => {
  const f = fixture();
  const res = await f.call('create');
  assert.equal(res.statusCode, 201);
  const request = f.calls.find(o => o.query.includes('BEGIN TRANSACTION'));
  assert.match(request.params.id, /^TASK-[a-f0-9]{64}$/);
  assert.match(request.query, /UPDATE `test-project.test_data.administration_task_registry_state`/);
  assert.match(request.query, /id='registry' AND revision>=0\s+AND contract_version=@contract_version/);
  assert.match(request.query, /ASSERT @@row_count=1/);
  assert.match(request.query, /INSERT INTO `test-project.test_data.administration_audit_log`/);
  assert.match(request.query, /reference_key=@reference_key/);
  assert.equal(request.params.reference_key, 'test-doc-cycle-01-prep');
  assert.match(request.query, /COMMIT TRANSACTION/);
  assert.doesNotMatch(request.query, /UPDATE .*taches_propres|INSERT INTO .*taches_propres/);
  assert.equal(request.types.due_date, 'STRING');
  assert.match(request.query, /CAST\(@due_date AS DATE\)/);
  const second = fixture();
  await second.call('create', { body: { ...body(), reference: '  test-doc-cycle-01-prep  ' } });
  assert.equal(second.calls.find(o => o.query.includes('BEGIN TRANSACTION')).params.id, request.params.id);
  const other = fixture();
  await other.call('create', { user: { ...user(), id: 'user-b' } });
  assert.equal(other.calls.find(o => o.query.includes('BEGIN TRANSACTION')).params.id, request.params.id);
});
test('identical create replay returns 200 and a conflicting reference returns 409', async () => {
  const f = fixture({ queryResult: o => o.query.includes('DECLARE replayed') ? [[rowFromParams(o.params, { replayed: true })]] : undefined });
  assert.equal((await f.call('create')).body.replayed, true);
  const g = fixture({ queryResult: o => {
    if (o.query.includes('DECLARE replayed')) throw new Error('Query error: TASK_DUPLICATE_REFERENCE');
  } });
  assert.equal((await g.call('create')).statusCode, 409);
});
test('a historical duplicate prevents any mutation', async () => {
  const f = fixture({ queryResult: o => o.query.startsWith('SELECT id FROM (') ? [[{ id: 'old' }]] : undefined });
  const res = await f.call('create');
  assert.equal(res.body.code, 'TASK_POTENTIAL_HISTORICAL_DUPLICATE');
  assert.equal(res.statusCode, 409);
  assert.equal(f.calls.some(o => o.query.includes('BEGIN TRANSACTION')), false);
});
test('update requires immutable reference and revision and scopes SQL to the owner', async () => {
  const id = `TASK-${'a'.repeat(64)}`;
  const { reference, ...task } = body();
  const f = fixture();
  const res = await f.call('update', { params: { id }, body: { expected_revision: 1, task } });
  assert.equal(res.statusCode, 200);
  const request = f.calls.find(o => o.query.includes('BEGIN TRANSACTION'));
  assert.match(request.query, /owner_user_id=@owner_user_id AND id=@id AND revision=@expected_revision/);
  assert.doesNotMatch(request.query, /SET reference=/);
  assert.equal(request.params.expected_revision, 1);
  const g = fixture();
  assert.equal((await g.call('update', { params: { id }, body: { expected_revision: 1, task: body() } })).statusCode, 400);
});
test('stale revision and concurrent transaction abort are reported as conflicts', async () => {
  const { reference, ...task } = body();
  for (const message of ['Query error: TASK_CONFLICT', 'Transaction aborted due to concurrent update']) {
    const f = fixture({ queryResult: o => { if (o.query.includes('BEGIN TRANSACTION')) throw new Error(message); } });
    const res = await f.call('update', { params: { id: `TASK-${'a'.repeat(64)}` }, body: { expected_revision: 1, task } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'TASK_CONFLICT');
  }
});
test('non-null due dates reach the SDK as strings and are cast only in SQL', async () => {
  const f = fixture();
  assert.equal((await f.call('create', { body: { ...body(), due_date: '2026-11-13' } })).statusCode, 201);
  const request = f.calls.find(o => o.query.includes('BEGIN TRANSACTION'));
  assert.equal(request.types.due_date, 'STRING');
  assert.equal(request.params.due_date, '2026-11-13');
  assert.match(request.query, /CAST\(@due_date AS DATE\)/);
});
test('update retry after an uncertain commit recognises exactly the same next revision and content', async () => {
  const { reference, ...task } = body();
  const f = fixture({ queryResult: o => o.query.includes('DECLARE update_replayed')
    ? [[rowFromParams(o.params, { revision: 2, replayed: true })]] : undefined });
  const res = await f.call('update', { params: { id: `TASK-${'a'.repeat(64)}` }, body: { expected_revision: 1, task } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.replayed, true);
  const request = f.calls.find(o => o.query.includes('BEGIN TRANSACTION'));
  assert.match(request.query, /revision=@expected_revision\+1 AND payload_hash=@payload_hash/);
  assert.match(request.query, /IF NOT update_replayed THEN/);
  assert.ok(request.query.indexOf('CREATE TEMP TABLE task_result') < request.query.indexOf('COMMIT TRANSACTION'));
});
test('historical reference matching applies the same whitespace canonicalisation as task ids', async () => {
  const f = fixture();
  await f.call('create', { body: { ...body(), reference: 'DOC  001' } });
  const check = f.calls.find(o => o.query.startsWith('SELECT id FROM ('));
  assert.match(check.query, /REGEXP_REPLACE\(NORMALIZE\(TRIM\(reference\),NFKC\),r'\\s\+'/);
  assert.equal(check.params.reference_key, 'doc 001');
});
test('server authenticates all task endpoints and no task delete endpoint exists', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  for (const [method, route] of [['get', '/api/tasks/access'], ['get', '/api/tasks/count'],
    ['get', '/api/tasks'], ['post', '/api/tasks'], ['put', '/api/tasks/:id']]) {
    assert.ok(server.includes(`app.${method}('${route}', authenticateRequest, taskRegistryHandlers.`));
  }
  assert.equal(server.includes("app.delete('/api/tasks"), false);
  assert.equal(server.includes('buildTaskRegistrySchemaPlan('), false);
});

test('storage describes both execution branches and keeps unknown progress nullable', () => {
  const fields = TASK_TABLE_CONTRACTS.administration_tasks.fields;
  for (const name of ['expected_result', 'assignee_agent_id', 'function_id', 'context_key',
    'source_links_json', 'source_origin_json']) assert.equal(fields.find(f => f.name === name).mode, 'REQUIRED');
  for (const name of ['project_id', 'phase_id', 'operational_plan_id', 'occurrence_identity', 'source_identity']) {
    assert.equal(fields.find(f => f.name === name).mode, 'NULLABLE');
  }
  assert.equal(fields.find(f => f.name === 'progression').mode, 'NULLABLE');
  const { progression, ...input } = body();
  assert.equal(normalizeTask(input).progression, null);
});

test('missing governed adapter leaves reads available and all mutations closed', async () => {
  const f = fixture({ withoutSource: true });
  const access = await f.call('access');
  assert.equal(access.body.enabled, true);
  assert.equal(access.body.can_write, false);
  assert.equal(access.body.write_contract_ready, false);
  assert.equal(access.body.code, 'TASK_CONTEXT_SOURCE_UNAVAILABLE');
  assert.equal((await f.call('create')).statusCode, 503);
  assert.equal((await f.call('list')).statusCode, 200);
  assert.equal(f.calls.some(o => o.query.includes('BEGIN TRANSACTION')), false);
  assert.ok(f.calls.at(-1).query.includes("'operational' AS source_kind,FALSE AS can_edit"));
});

test('old clients cannot advertise writes or send the obsolete payload', async () => {
  const f = fixture();
  const res = await f.call('access', { query: {} });
  assert.equal(res.body.can_write, false);
  assert.equal(res.body.client_contract_compatible, false);
  assert.equal(res.body.code, 'TASK_CONTRACT_MISMATCH');
  await f.call('list', { query: {} });
  assert.ok(f.calls.at(-1).query.includes("'operational' AS source_kind,FALSE AS can_edit"));
  for (const contract_version of [undefined, 'm3s.task-execution.v1']) {
    const g = fixture();
    const response = await g.call('create', { body: { ...body(), contract_version } });
    assert.equal(response.body.code, 'TASK_CONTRACT_MISMATCH');
    assert.equal(g.calls.length, 0);
  }
});

test('a wrong state version or mixed stored contract versions disables native storage', async () => {
  for (const row of [{ total: 1, valid: 0, invalid_task_versions: 0 },
    { total: 1, valid: 1, invalid_task_versions: 1 }]) {
    const f = fixture({ queryResult: o => o.query.includes("COUNTIF(id='registry'") ? [[row]] : undefined });
    assert.equal((await f.call('access')).body.enabled, false);
    assert.equal((await f.call('create')).statusCode, 503);
    assert.equal(f.calls.some(o => o.query.includes('BEGIN TRANSACTION')), false);
  }
});

test('project ancestry and responsible display are derived from actor-bound references', async () => {
  const f = fixture();
  const res = await f.call('create', { body: { ...body(), progression: null,
    execution_context: { ...body().execution_context, activity_id: 'activity-test' } } });
  assert.equal(res.statusCode, 201);
  const request = f.calls.find(o => o.query.includes('BEGIN TRANSACTION'));
  assert.equal(request.params.project_id, 'project-test');
  assert.equal(request.params.dossier_id, 'dossier-test');
  assert.equal(request.params.portfolio_id, 'portfolio-test');
  assert.equal(request.params.activity_id, 'activity-test');
  assert.equal(request.params.operational_plan_id, null);
  assert.equal(request.params.responsable, 'Responsable interne');
  assert.equal(request.params.progression, null);
  assert.deepEqual(f.boundActors[0], { tenantId: 'tenant-a', actorId: 'user-a', permissions: user().permissions, role: 'Manager', principal: user() });
  assert.equal(f.assignmentInputs[0].context.project_id, 'project-test');
  assert.equal(f.assignmentInputs[0].context.phase_id, 'phase-test');
  assert.deepEqual(f.sourceInputs[0].context, f.assignmentInputs[0].context);
  assert.equal(res.body.data.execution_context.phase_id, 'phase-test');
  assert.equal(res.body.data.related_reference, 'COR-TEST');
  assert.throws(() => normalizeTask({ ...body(), responsable: 'Forged' }), { code: 'TASK_INVALID' });
  assert.throws(() => normalizeTask({ ...body(), project_id: 'Forged' }), { code: 'TASK_INVALID' });
});

const operation = (key = null) => ({ execution_kind: 'operation', phase_id: null, activity_id: null,
  operational_plan_id: 'plan-test', recurrence_id: key ? 'recurrence-test' : null, occurrence_key: key });

test('finance task write rechecks the native plan, decision and assignment inside its transaction', async () => {
  const hash = 'a'.repeat(64);
  const f = fixture({ finance: true, assignmentChange: assignment => ({ ...assignment, id: 'assignment-test' }),
    bindingChange: binding => ({ ...binding, financialWriteGuard: { planId: 'plan-test', assignmentId: 'assignment-test',
      decisionReference: hash, decisionSha256: hash, decisionVersion: '0', registration: 'registration-test', sourceReference: 'COR-TEST',
      planSourceKey: 'finance/plan', planLabel: 'Finance', portfolioRegistration: 'portfolio-proof' } }) });
  const res = await f.call('create', { body: { ...body(), function_id: 'finance', module: 'FINANCES', execution_context: operation() } });
  assert.equal(res.statusCode, 201);
  const tx = f.calls.find(call => call.query.includes('BEGIN TRANSACTION'));
  assert.ok(tx.query.indexOf('TASK_FINANCIAL_CONTEXT_CHANGED') < tx.query.indexOf('INSERT INTO `test-project.test_data.administration_tasks`'));
  assert.match(tx.query, /a\.actor_user_id=@owner_user_id/);
  assert.match(tx.query, /p\.decision_sha256=@finance_decision/);
  assert.match(tx.query, /revision=@finance_observed_revision/);
  assert.equal(tx.params.finance_observed_revision, 12);
  assert.match(tx.query, /p\.source_key=@finance_plan_source AND p\.label=@finance_plan_label/);
  assert.match(tx.query, /source_ref=@finance_portfolio_registration/);
  assert.match(tx.query, /id=@finance_source_reference/);
  assert.match(tx.query, /portfolio_id=@portfolio_id AND function_id='management_governance'/);
  assert.equal(tx.params.finance_assignment_id, 'assignment-test');
  assert.equal(tx.params.finance_decision, hash);
  assert.deepEqual(JSON.parse(tx.params.metadata_json).financial_context, { plan_id: 'plan-test',
    assignment_id: 'assignment-test', decision_sha256: hash, decision_revision: '0',
    registration_reference: 'registration-test', source_reference: 'COR-TEST' });
});

test('finance task fails closed if the trusted write guard is missing or the transaction detects a change', async () => {
  const request = { body: { ...body(), function_id: 'finance', module: 'FINANCES', execution_context: operation() } };
  const absent = fixture({ finance: true });
  assert.equal((await absent.call('create', request)).statusCode, 503);
  assert.equal(absent.calls.some(call => call.query.includes('BEGIN TRANSACTION')), false);
  const hash = 'b'.repeat(64);
  const changed = fixture({ finance: true, assignmentChange: a => ({ ...a, id: 'assignment-test' }),
    bindingChange: binding => ({ ...binding, financialWriteGuard: { planId: 'plan-test', assignmentId: 'assignment-test',
      decisionReference: hash, decisionSha256: hash, decisionVersion: '0', registration: 'registration-test', sourceReference: 'COR-TEST',
      planSourceKey: 'finance/plan', planLabel: 'Finance', portfolioRegistration: 'portfolio-proof' } }),
    queryResult: options => { if (options.query.includes('BEGIN TRANSACTION')) throw Error('TASK_FINANCIAL_CONTEXT_CHANGED'); } });
  const res = await changed.call('create', request);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'TASK_CONFLICT');
});

test('finance task refuses a frozen or invalid shared revision before qualifying the GED', async () => {
  const request = { body: { ...body(), function_id: 'finance', module: 'FINANCES', execution_context: operation() } };
  for (const value of [-1, null, 'not-a-revision']) {
    const f = fixture({ finance: true, queryResult: options => options.query.startsWith('SELECT revision,contract_version FROM')
      ? [[{ revision: value, contract_version: VERSION }]] : undefined });
    const res = await f.call('create', request);
    assert.equal(res.statusCode, 503);
    assert.equal(f.boundActors.length, 0);
    assert.equal(f.calls.some(call => call.query.includes('BEGIN TRANSACTION')), false);
  }
});

test('simulated GED change between verification and task write invalidates the captured finance revision', async () => {
  const { createFinanceGedGateCandidate } = require('../financeGedGateCandidate');
  let revision = 12, documentRevision = 0, writes = 0;
  const gateStore = { async query({ query }) {
    if (query.includes('SET revision=-revision-1')) { revision = -revision - 1; return [[{ revision }]]; }
    if (query.includes('SET revision=-revision')) { revision = -revision; return [[{ revision }]]; }
    throw Error('unexpected synthetic query');
  } };
  const gate = createFinanceGedGateCandidate({ bigquery: gateStore, projectId: 'test-project', datasetId: 'test_data' });
  const hash = 'c'.repeat(64);
  const f = fixture({ finance: true, assignmentChange: a => ({ ...a, id: 'assignment-test' }),
    bindingChange: async binding => {
      await gate.protectMutation({ tenantId: '2sg', actorId: 'user-a', documentId: hash, expectedRevision: 0 },
        async () => { documentRevision++; });
      return { ...binding, financialWriteGuard: { planId: 'plan-test', assignmentId: 'assignment-test',
        decisionReference: hash, decisionSha256: hash, decisionVersion: '0', registration: 'registration-test',
        sourceReference: 'COR-TEST', planSourceKey: 'finance/plan', planLabel: 'Finance', portfolioRegistration: 'portfolio-proof' } };
    },
    queryResult: options => {
      if (options.query.startsWith('SELECT revision,contract_version FROM')) return [[{ revision, contract_version: VERSION }]];
      if (options.query.includes('BEGIN TRANSACTION')) {
        if (options.params.finance_observed_revision !== revision) throw Error('TASK_FINANCIAL_CONTEXT_CHANGED');
        writes++;
      }
    } });
  const res = await f.call('create', { body: { ...body(), function_id: 'finance', module: 'FINANCES', execution_context: operation() } });
  assert.equal(res.statusCode, 409);
  assert.equal(documentRevision, 1);
  assert.equal(revision, 13);
  assert.equal(writes, 0);
});

test.todo('GED revision and BigQuery task write remain ordered after a process or connection failure');

test('operations require a governed plan and never acquire an artificial project or phase', async () => {
  const f = fixture();
  const res = await f.call('create', { body: { ...body(), execution_context: operation() } });
  assert.equal(res.statusCode, 201);
  const params = f.calls.find(o => o.query.includes('BEGIN TRANSACTION')).params;
  assert.equal(params.operational_plan_id, 'plan-test');
  for (const key of ['project_id', 'phase_id', 'activity_id', 'recurrence_id', 'occurrence_identity']) {
    assert.equal(params[key], null);
  }
  assert.equal(params.function_id, 'function-test');
  assert.equal(params.portfolio_id, 'portfolio-test');
});

test('recurring identity is tenant-wide and occurrence-specific, with title reuse allowed', async () => {
  const requests = [];
  for (const [key, actor] of [['2026-11', 'user-a'], ['2026-11', 'user-b'], ['2026-12', 'user-a']]) {
    const f = fixture();
    assert.equal((await f.call('create', { user: { ...user(), id: actor },
      body: { ...body(), execution_context: operation(key) } })).statusCode, 201);
    requests.push(f.calls.find(o => o.query.includes('BEGIN TRANSACTION')));
    assert.equal(f.calls.find(o => o.query.startsWith('SELECT id FROM (')).params.check_title, false);
  }
  assert.equal(requests[0].params.occurrence_identity, requests[1].params.occurrence_identity);
  assert.notEqual(requests[0].params.occurrence_identity, requests[2].params.occurrence_identity);
  const f = fixture();
  assert.equal((await f.call('create', { body: { ...body(), execution_context: operation('2026-13') } })).statusCode, 400);
  assert.equal(f.calls.some(o => o.query.includes('BEGIN TRANSACTION')), false);
});

test('deduplication claims reference, occurrence and origin without exposing another owner row', async () => {
  const f = fixture();
  await f.call('create');
  const request = f.calls.find(o => o.query.includes('BEGIN TRANSACTION'));
  const claim = request.query.slice(request.query.indexOf('ASSERT NOT EXISTS'), request.query.indexOf('ASSERT (SELECT COUNT(*)'));
  assert.match(claim, /tenant_id=@tenant_id AND id!=@id AND \(reference_key=@reference_key/);
  assert.match(claim, /occurrence_identity=@occurrence_identity/);
  assert.match(claim, /source_identity=@source_identity/);
  assert.doesNotMatch(claim, /owner_user_id/);
  assert.match(request.query, /owner_user_id=@owner_user_id\s+AND id=@id AND payload_hash=@payload_hash/);
  const g = fixture();
  await g.call('create', { body: { ...body(), source_links: [{ kind: 'ged', reference: 'OTHER-EVIDENCE' }] } });
  assert.equal(g.calls.find(o => o.query.includes('BEGIN TRANSACTION')).params.source_identity, request.params.source_identity);
  const h = fixture();
  await h.call('create', { body: { ...body(), source_origin: null } });
  assert.equal(h.calls.find(o => o.query.includes('BEGIN TRANSACTION')).params.source_identity, null);
});

test('historical origin cannot be recreated as a native task', async () => {
  const f = fixture();
  const res = await f.call('create', { body: { ...body(), source_origin: { kind: 'historical_task', reference: 'old-1' } } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'TASK_POTENTIAL_HISTORICAL_DUPLICATE');
  assert.equal(f.calls.length, 0);
});

test('unqualified assignment, operation function or source never starts a transaction', async () => {
  const cases = [
    [{ assignmentChange: a => ({ ...a, tenant_id: 'other' }) }, body(), 'TASK_ASSIGNMENT_UNQUALIFIED'],
    [{ assignmentChange: a => ({ ...a, governance_status: 'draft' }) }, body(), 'TASK_ASSIGNMENT_UNQUALIFIED'],
    [{ assignmentChange: a => ({ ...a, agent_display_name: '' }) }, body(), 'TASK_ASSIGNMENT_UNQUALIFIED'],
    [{}, { ...body(), function_id: 'different', execution_context: operation() }, 'TASK_ASSIGNMENT_UNQUALIFIED'],
    [{ sourceAllowed: false }, body(), 'TASK_SOURCE_UNQUALIFIED'],
    [{ sourceThrows: true }, body(), 'TASK_CONTEXT_SOURCE_UNAVAILABLE'],
    [{ bindingChange: b => ({ ...b, contract_version: 'old' }) }, body(), 'TASK_CONTEXT_SOURCE_UNAVAILABLE']
  ];
  for (const [options, input, code] of cases) {
    const f = fixture(options);
    const res = await f.call('create', { body: input });
    assert.equal(res.body.code, code);
    assert.equal(f.calls.some(o => o.query.includes('BEGIN TRANSACTION')), false);
    assert.equal(JSON.stringify(res.body).includes('private source error'), false);
  }
});

test('native revisions preserve execution context and bind every SQL parameter', async () => {
  const f = fixture();
  const { reference, ...task } = body();
  await f.call('update', { params: { id: `TASK-${'a'.repeat(64)}` }, body: { expected_revision: 2, task } });
  const request = f.calls.find(o => o.query.includes('BEGIN TRANSACTION'));
  assert.match(request.query, /revision=@expected_revision AND context_key=@context_key/);
  assert.equal(request.params.reference_key, '');
  for (const match of request.query.matchAll(/(?<!@)@([a-z_]+)/g)) {
    assert.ok(Object.hasOwn(request.params, match[1]), `missing parameter ${match[1]}`);
  }
});

test('source dates stay distinct from native planning, actual service and technical timestamps', async () => {
  const historical = { id: 'old-1', source_kind: 'historical', title: 'old', progression: 12.5,
    source_start_date: '2025-01-02', source_due_date: '2025-02-03', created_at: '2025-01-02' };
  const f = fixture({ queryResult: o => o.query.includes('ARRAY(SELECT AS STRUCT')
    ? [[{ total: 1, items: [historical] }]] : undefined });
  const list = await f.call('list');
  assert.equal(list.body.data[0].created_at, null);
  assert.equal(list.body.data[0].date_debut, '2025-01-02');
  assert.equal(list.body.data[0].date_fin, '2025-02-03');
  assert.equal(list.body.data[0].progression, 12.5);
  assert.match(f.calls.at(-1).query, /CAST\(progression AS FLOAT64\)/);
  const g = fixture();
  const created = await g.call('create', { body: { ...body(), planned_start_date: '2026-11-01',
    due_date: '2026-11-03', actual_start_date: '2026-11-02', actual_end_date: '2026-11-03' } });
  assert.equal(created.body.data.date_debut, '2026-11-01');
  assert.equal(created.body.data.actual_start_date, '2026-11-02');
  assert.equal(created.body.data.created_at, '2026-10-18T10:00:00Z');
});

test('malformed stored JSON never becomes an editable row', async () => {
  const f = fixture({ queryResult: o => o.query.includes('BEGIN TRANSACTION')
    ? [[rowFromParams(o.params, { source_links_json: '{broken' })]] : undefined });
  const res = await f.call('create');
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.data, undefined);
});

test('provenance strings reach SQL only through bound parameters', async () => {
  const f = fixture();
  const reference = "COR-001'; DELETE FROM important; --";
  const res = await f.call('create', { body: { ...body(), source_origin: { kind: 'correspondence', reference } } });
  assert.equal(res.statusCode, 201);
  const request = f.calls.find(o => o.query.includes('BEGIN TRANSACTION'));
  assert.equal(JSON.parse(request.params.source_origin_json).reference, reference);
  assert.doesNotMatch(request.query, /DELETE FROM important/);
});

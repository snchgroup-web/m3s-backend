const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { validateBudget, buildBudgetSchemaStatements, budgetDraftsEnabled, createBudgetDraftHandlers,
  createBudgetAccountMiddleware, createBudgetBodyMiddleware } = require('../financeBudgetDrafts');

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const writer = { id: 'user-a', tenantId: 'org-a', financePermissionsExplicit: true, permissions: ['finance:read', 'finance:write'] };
const reader = { ...writer, permissions: ['finance:read'] };
const draft = () => ({ title: 'Previsions 2026', entity: 'Organisation test', year: '2026', revision: 0,
  rate: '', rateSource: '', rateDate: '', rows: [{ id: 'line-1', label: 'Charges', kind: 'operating',
    direction: 'out', currency: 'CHF', months: ['0', '12,50', ...Array(10).fill('')] }] });
const response = () => ({ statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; },
  set(k, v) { this.headers[k] = v; return this; }, json(body) { this.body = body; return this; } });
const request = (extra = {}) => ({ user: writer, params: { id: ID }, query: {}, body: { budget: draft() }, ...extra });
function fixture(outcomes = [], config = {}) {
  const calls = []; const logs = [];
  let ids = 0;
  const handlers = createBudgetDraftHandlers({ bigquery: { async query(options) {
    calls.push(options); const result = outcomes.shift(); if (result instanceof Error) throw result;
    return [result || []];
  } }, projectId: 'test-project', datasetId: 'budget_test', location: 'EU', enabled: true,
  idGenerator: () => ++ids === 1 ? ID : EVENT, logger: { error(...args) { logs.push(args); } }, ...config });
  return { handlers, calls, logs };
}
const record = (budget = draft(), version = 1) => ({ id: ID, version, title: budget.title, entity: budget.entity,
  year: budget.year, budget_json: JSON.stringify(budget), created_at: { value: '2026-09-03T12:00:00Z' },
  updated_at: { value: '2026-09-03T12:00:00Z' } });

test('valid drafts preserve decimal strings, zero, gaps, CHF/CFA and export revision', () => {
  const budget = draft(); budget.revision = 1000000;
  budget.rows.push({ ...budget.rows[0], id: 'line-2', currency: 'CFA', kind: 'financing', direction: 'in' });
  assert.deepEqual(JSON.parse(validateBudget(budget)), budget);
  budget.rows = []; assert.doesNotThrow(() => validateBudget(budget));
});

const invalidChanges = {
  title: b => { b.title = ''; }, entity: b => { b.entity = ' '; }, year: b => { b.year = '2101'; },
  numericYear: b => { b.year = 2026; }, revision: b => { b.revision = 1.5; },
  personal: b => { b.scope = 'personal'; }, tenant: b => { b.tenantId = 'other'; },
  owner: b => { b.ownerId = 'other'; }, approved: b => { b.status = 'approved'; },
  actuals: b => { b.rows[0].actuals = 4; }, currency: b => { b.rows[0].currency = 'EUR'; },
  direction: b => { b.rows[0].direction = 'transfer'; }, kind: b => { b.rows[0].kind = 'actual'; },
  duplicate: b => { b.rows.push({ ...b.rows[0] }); }, tooMany: b => { b.rows = Array.from({ length: 101 }, (_, i) => ({ ...b.rows[0], id: String(i) })); },
  months: b => { b.rows[0].months.pop(); }, negative: b => { b.rows[0].months[0] = '-1'; },
  precision: b => { b.rows[0].months[0] = '1.001'; }, exponent: b => { b.rows[0].months[0] = '1e3'; },
  nonString: b => { b.rows[0].months[0] = 1; }, overflow: b => { b.rows[0].months[0] = '1000000000.01'; },
  missingRateSource: b => { b.rate = '710'; b.rateDate = '2026-09-03'; },
  orphanRateSource: b => { b.rateSource = 'external'; },
  invalidRateDate: b => { b.rate = '710'; b.rateSource = 'test'; b.rateDate = '2026-02-30'; }
};
for (const [name, mutate] of Object.entries(invalidChanges)) test(`validation rejects ${name}`, () => {
  const budget = draft(); mutate(budget); assert.throws(() => validateBudget(budget), /Invalid budget/);
});
test('explicit rate boundaries require provenance and date', () => {
  const b = { ...draft(), rate: '710,123456', rateSource: 'Hypothese test', rateDate: '2026-09-03' };
  assert.doesNotThrow(() => validateBudget(b));
  for (const rate of ['0', '-1', '1e3', 'Infinity', '1000001', '710.1234567']) {
    assert.throws(() => validateBudget({ ...b, rate }));
  }
});
test('schema generation is isolated, identifier-safe and never executes a query', () => {
  const statements = buildBudgetSchemaStatements({ projectId: 'test-project', datasetId: 'budget_test' });
  assert.equal(statements.length, 2);
  assert(statements.every(sql => sql.includes('CLUSTER BY tenant_id')));
  assert.match(statements[0], /finance_budget_drafts_v1/);
  assert.doesNotMatch(statements[1], /budget_json|title|amount/i);
  for (const params of [{ projectId: 'x`; DROP TABLE x', datasetId: 'ok' }, { projectId: 'ok', datasetId: 'x.y' }]) {
    assert.throws(() => buildBudgetSchemaStatements(params), /Invalid BigQuery/);
  }
});
test('activation fails closed, including legacy auth bypass or missing signing key', () => {
  const valid = { FINANCE_BUDGET_DRAFTS_ENABLED: 'true', API_REQUIRE_AUTH: 'true', JWT_SECRET: 'x'.repeat(32) };
  assert.equal(budgetDraftsEnabled(valid), true);
  for (const key of Object.keys(valid)) assert.equal(budgetDraftsEnabled({ ...valid, [key]: undefined }), false);
  assert.equal(budgetDraftsEnabled({ ...valid, FINANCE_BUDGET_DRAFTS_ENABLED: '1' }), false);
  assert.equal(budgetDraftsEnabled({ ...valid, JWT_SECRET: 'm3s-development-secret-change-me' }), false);
});
test('current account controls rights even when a token carries older write grants', () => {
  let accounts = [{ id: writer.id, tenantId: writer.tenantId, financePermissions: ['finance:read'] }];
  const guard = createBudgetAccountMiddleware({ getAccounts: () => accounts });
  const req = request(); const res = response(); let advanced = false;
  guard(req, res, () => { advanced = true; });
  assert(advanced); assert.deepEqual(req.user.permissions, ['finance:read']);
  for (const changes of [{ active: false }, { tenantId: 'other' }, { id: 'other' }]) {
    accounts = [{ ...accounts[0], ...changes }]; const denied = response();
    guard(request(), denied, () => assert.fail('Inactive or mismatched account passed'));
    assert.equal(denied.statusCode, 401);
    accounts = [{ id: writer.id, tenantId: writer.tenantId }];
  }
});
test('all handlers deny missing identity and never query BigQuery', async () => {
  const { handlers, calls } = fixture();
  for (const handler of Object.values(handlers)) {
    for (const user of [undefined, { id: 'only-id' }, { tenantId: 'only-tenant' }]) {
      const res = response(); await handler(request({ user }), res); assert.equal(res.statusCode, 401);
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
  }
  assert.equal(calls.length, 0);
});
test('permission and disabled-state guards execute before any storage access', async () => {
  const { handlers, calls } = fixture([], { enabled: false });
  const res = response(); await handlers.capabilities(request(), res);
  assert.equal(res.body.enabled, false); assert.equal(res.body.personalEnabled, false);
  for (const name of ['list', 'get', 'create', 'update']) {
    const disabled = response(); await handlers[name](request(), disabled); assert.equal(disabled.statusCode, 503);
  }
  const enabled = fixture();
  for (const name of ['create', 'update']) {
    const denied = response(); await enabled.handlers[name](request({ user: reader }), denied); assert.equal(denied.statusCode, 403);
  }
  const denied = response(); await enabled.handlers.list(request({ user: { ...writer, permissions: [] } }), denied);
  assert.equal(denied.statusCode, 403); assert.equal(calls.length + enabled.calls.length, 0);
});
test('list is author-and-tenant scoped, bounded and excludes budget contents', async () => {
  const { handlers, calls } = fixture([[record(), record()]]); const res = response();
  await handlers.list(request({ query: { limit: '1', offset: '0' } }), res);
  assert.equal(res.body.data.length, 1); assert.equal(res.body.hasMore, true);
  assert.equal(res.body.data[0].budget_json, undefined);
  assert.match(calls[0].query, /tenant_id = @tenantId AND owner_user_id = @ownerId/);
  assert.doesNotMatch(calls[0].query, /budget_json/); assert.equal(calls[0].params.ownerId, writer.id);
  assert.equal(calls[0].params.tenantId, writer.tenantId); assert.equal(calls[0].params.limit, 2);
  assert.equal(calls[0].location, 'EU');
  for (const query of [{ tenantId: 'other' }, { limit: '51' }, { offset: '-1' }, { limit: '1x' }, { offset: '10001' }, { limit: ['1'] }]) {
    const rejected = response(); await handlers.list(request({ query }), rejected); assert.equal(rejected.statusCode, 400);
  }
  assert.equal(calls.length, 1);
});
test('get returns exact values only for the scoped id, not a cached fallback', async () => {
  const { handlers, calls } = fixture([[record()], []]); const res = response();
  await handlers.get(request(), res); assert.deepEqual(res.body.data.budget, draft());
  assert.equal(res.body.data.version, 1); assert.equal(res.body.data.createdAt, '2026-09-03T12:00:00Z');
  assert.match(calls[0].query, /tenant_id = @tenantId AND owner_user_id = @ownerId AND id = @id/);
  const missing = response(); await handlers.get(request({ user: { ...writer, id: 'other' } }), missing);
  assert.equal(missing.statusCode, 404);
  const bad = response(); await handlers.get(request({ params: { id: "' OR 1=1" } }), bad);
  assert.equal(bad.statusCode, 400); assert.equal(calls.length, 2);
});
test('malformed or duplicate stored records fail closed', async () => {
  for (const rows of [[record(), record()], [{ ...record(), budget_json: 'bad' }], [record(draft(), 'NaN')]]) {
    const { handlers } = fixture([rows]); const res = response();
    await handlers.get(request(), res); assert.equal(res.statusCode, 503); assert.equal(res.body.data, undefined);
  }
});
test('create uses server identity, bound payload and a single atomic audit transaction', async () => {
  const { handlers, calls } = fixture([[{ outcome: 'saved', version: 1 }]]); const res = response();
  const budget = draft(); budget.title = "x'); DROP TABLE test; --"; budget.revision = 94;
  await handlers.create(request({ body: { budget } }), res);
  assert.equal(res.statusCode, 201); assert.equal(res.body.data.version, 1); assert.equal(calls.length, 1);
  assert.equal(res.body.data.id, ID); assert.equal(calls[0].params.ownerId, writer.id);
  assert.equal(JSON.parse(calls[0].params.budgetJson).revision, 94);
  assert.equal(calls[0].params.title, budget.title); assert(!calls[0].query.includes(budget.title));
  assert.match(calls[0].query, /BEGIN TRANSACTION;[\s\S]*INSERT INTO .*finance_budget_drafts_v1[\s\S]*INSERT INTO .*finance_budget_draft_events_v1[\s\S]*COMMIT TRANSACTION;/);
});
test('payload impersonation and invalid compare versions never reach storage', async () => {
  const { handlers, calls } = fixture();
  for (const body of [{ budget: draft(), tenantId: 'other' }, { budget: draft(), scope: 'personal' }, null, { budget: { ...draft(), status: 'approved' } }]) {
    const res = response(); await handlers.create(request({ body }), res); assert.equal(res.statusCode, 400);
  }
  for (const expectedVersion of [undefined, '1', 0, -1, 1.5, 1000000]) {
    const res = response(); await handlers.update(request({ body: { budget: draft(), expectedVersion } }), res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});
test('update compares version in its atomic transaction, never a read-then-unconditional-write', async () => {
  const { handlers, calls } = fixture([[{ outcome: 'saved', version: 8 }]]); const res = response();
  await handlers.update(request({ body: { budget: draft(), expectedVersion: 7 } }), res);
  assert.equal(res.body.data.version, 8); assert.equal(calls.length, 1);
  const sql = calls[0].query;
  assert.match(sql, /BEGIN TRANSACTION;[\s\S]*SET matches[\s\S]*ASSERT matches <= 1/);
  assert.match(sql, /WHERE tenant_id = @tenantId AND owner_user_id = @ownerId AND id = @id AND version = @expectedVersion/);
  assert.match(sql, /IF @@row_count = 1 THEN[\s\S]*INSERT INTO .*finance_budget_draft_events_v1/);
  assert.equal(calls[0].params.expectedVersion, 7); assert.equal(calls[0].params.nextVersion, 8);
});
test('stale and missing draft results are distinct without leaking other tenants', async () => {
  for (const [outcome, code] of [['missing', 404], ['conflict', 409], ['invalid', 503]]) {
    const { handlers } = fixture([[{ outcome }]]); const res = response();
    await handlers.update(request({ body: { budget: draft(), expectedVersion: 1 } }), res);
    assert.equal(res.statusCode, code); assert.equal(res.body.data, undefined);
  }
});
test('ambiguous writes return reconciliation id, no success, no payload logs, no retry', async () => {
  for (const [message, code] of [['private contents from SQL', 503], ['Transaction aborted due to concurrent update', 409]]) {
    const { handlers, calls, logs } = fixture([new Error(message)]); const res = response();
    await handlers.create(request(), res);
    assert.equal(res.statusCode, code); assert.equal(res.body.draftId, ID); assert.equal(res.body.reconcileRequired, true);
    assert.equal(calls.length, 1); assert(!JSON.stringify(logs).includes(message));
    assert(!JSON.stringify(res.body).includes(message));
  }
});

test('HTTP integration: isolation, reload, competing versions, current rights and body bound', async () => {
  const records = []; const audit = []; let n = 0;
  const users = new Map([['a', writer], ['b', { ...writer, id: 'user-b' }], ['c', { ...writer, tenantId: 'org-b' }]]);
  let accounts = [...users.values()].map(u => ({ id: u.id, tenantId: u.tenantId, financePermissions: [...u.permissions] }));
  // Explicit store double. It simulates atomic statements, not the BigQuery SQL engine.
  const bigquery = { async query({ query: sql, params: p }) {
    const owns = r => r.tenant_id === p.tenantId && r.owner_user_id === p.ownerId;
    if (sql.startsWith('BEGIN TRANSACTION')) {
      records.push({ ...record(JSON.parse(p.budgetJson)), id: p.id, tenant_id: p.tenantId, owner_user_id: p.ownerId });
      audit.push({ id: p.id, version: 1 }); return [[{ outcome: 'saved', version: 1 }]];
    }
    if (sql.startsWith('DECLARE')) {
      const r = records.find(r => owns(r) && r.id === p.id);
      if (!r) return [[{ outcome: 'missing' }]];
      if (r.version !== p.expectedVersion) return [[{ outcome: 'conflict' }]];
      Object.assign(r, { version: p.nextVersion, budget_json: p.budgetJson });
      audit.push({ id: p.id, version: p.nextVersion }); return [[{ outcome: 'saved', version: p.nextVersion }]];
    }
    return [records.filter(r => owns(r) && (!p.id || r.id === p.id))];
  } };
  const handlers = createBudgetDraftHandlers({ bigquery, projectId: 'test', datasetId: 'test', enabled: true,
    idGenerator: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}` });
  const app = express(); app.use(createBudgetBodyMiddleware());
  app.use((req, res, next) => { req.user = users.get(req.get('x-test-user')); next(); });
  app.use(createBudgetAccountMiddleware({ getAccounts: () => accounts }));
  app.get('/drafts', handlers.list); app.post('/drafts', handlers.create);
  app.get('/drafts/:id', handlers.get); app.put('/drafts/:id', handlers.update);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ code: 'REQUEST_REJECTED' }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, user = 'a') => {
    const result = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json(), cache: result.headers.get('cache-control') };
  };
  try {
    const created = await call('POST', '/drafts', { budget: draft() }); assert.equal(created.status, 201);
    const route = '/drafts/' + created.body.data.id;
    const loaded = await call('GET', route); assert.deepEqual(loaded.body.data.budget, draft()); assert.equal(loaded.cache, 'no-store');
    for (const user of ['b', 'c']) {
      assert.equal((await call('GET', route, undefined, user)).status, 404);
      assert.deepEqual((await call('GET', '/drafts', undefined, user)).body.data, []);
      assert.equal((await call('PUT', route, { budget: draft(), expectedVersion: 1 }, user)).status, 404);
    }
    const body = { budget: { ...draft(), title: 'Revision suivante' }, expectedVersion: 1 };
    const first = await call('PUT', route, body);
    const second = await call('PUT', route, { ...body, budget: { ...draft(), title: 'Ancien onglet' } });
    assert.equal(first.status, 200); assert.equal(second.status, 409);
    assert.equal((await call('GET', route)).body.data.budget.title, 'Revision suivante'); assert.equal(audit.length, 2);
    accounts[0].financePermissions = ['finance:read'];
    assert.equal((await call('PUT', route, { ...body, expectedVersion: 2 })).status, 403);
    accounts[0].active = false; assert.equal((await call('GET', route)).status, 401);
    assert.equal((await call('GET', route, undefined, 'unknown')).status, 401);
    assert.equal((await call('POST', '/drafts', { budget: draft(), extra: 'x'.repeat(512 * 1024) })).status, 413);
    const malformed = await fetch(base + '/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{secret amount' });
    assert.equal(malformed.status, 400); assert(!(await malformed.text()).includes('secret amount'));
    const form = await fetch(base + '/drafts', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'budget=secret' });
    assert.equal(form.status, 415); assert(!(await form.text()).includes('secret'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('server wiring places budget parser before global parser, auth before every route, and no schema bootstrap', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert(source.indexOf("app.use('/api/finance/budget-drafts', createBudgetBodyMiddleware())") < source.indexOf("app.use(express.json({ limit: '50mb'"));
  const guard = source.indexOf("app.use('/api/finance/budget-drafts', authenticateRequest, requireCurrentBudgetAccount)");
  assert(guard > 0);
  for (const line of source.split('\n').filter(s => /app\.(get|post|put)\('\/api\/finance\/budget-drafts/.test(s))) {
    assert(source.indexOf(line) > guard);
  }
  assert.doesNotMatch(source, /buildBudgetSchemaStatements|ensureBudgetSchema/);
});

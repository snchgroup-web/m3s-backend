const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { createGedRouter } = require('../gedPrivate');
const { createRegister, validateExpenseDocumentLink } = require('../gedPrivateRegister');
const { digest } = require('../gedPrivatePolicy');

const pdfEntry = (name, category) => {
  const bytes = Buffer.from(`%PDF-1.4\nSYNTHETIC ${name}\n%%EOF`);
  return { name: `${name}.pdf`, sha256: digest(bytes), size: bytes.length, category };
};

async function registerFixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(readFileSync(require.resolve('../sql/ged-private-v1.sql'), 'utf8'));
  await db.exec(`CREATE ROLE m3s_ged_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT USAGE ON SCHEMA ged_private TO m3s_ged_app;
    GRANT SELECT, INSERT ON ged_private.documents TO m3s_ged_app;
    GRANT INSERT ON ged_private.events TO m3s_ged_app;`);
  await db.exec(readFileSync(require.resolve('../sql/ged-lifecycle-v2.sql'), 'utf8'));
  await db.exec(readFileSync(require.resolve('../sql/ged-expense-links-candidate.sql'), 'utf8'));
  await db.exec('GRANT SELECT, INSERT ON ged_private.expense_document_links TO m3s_ged_app; SET ROLE m3s_ged_app;');
  const entries = [pdfEntry('Invoice root', 'finance'), pdfEntry('Invoice version', 'finance'),
    pdfEntry('Private note', 'personal')];
  const policy = { owner: { userId: 'synthetic-user', organizationId: 'synthetic-org' }, documents: entries };
  const scope = { tenant: digest(policy.owner.organizationId), owner: digest(policy.owner.userId) };
  const pool = { connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }) };
  const register = createRegister(pool, { lifecyclePolicy: policy });
  for (const entry of entries) await register.create(scope, entry, '1234567890');
  return { db, entries, policy, scope, register,
    expense: { id: 'DEP-SYNTHETIC', source: 'synthetic.expenses' } };
}

test('expense attachment input is small, strict and normalized', () => {
  const id = 'a'.repeat(64);
  assert.deepEqual(validateExpenseDocumentLink({ documentId: id, versionId: id, documentRole: 'invoice' }),
    { documentId: id, versionId: id, documentRole: 'invoice', externalReference: null });
  for (const value of [null, [], {},
    { documentId: id, versionId: id, documentRole: 'unknown' },
    { documentId: id, versionId: id, documentRole: 'invoice', extra: true },
    { documentId: id, versionId: id, documentRole: 'invoice', externalReference: ' padded ' },
    { documentId: id, versionId: id, documentRole: 'invoice', externalReference: '<unsafe>' }]) {
    assert.throws(() => validateExpenseDocumentLink(value), /GED_INVALID_COMMAND/);
  }
});

test('server wires GED finance authorization independently of the legacy API auth flag', () => {
  const source = readFileSync(require.resolve('../server.js'), 'utf8');
  const start = source.indexOf('app.use(GED_PREFIX, createGedRuntime');
  const end = source.indexOf("app.get('/api/auth/provider'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const wiring = source.slice(start, end);
  assert.match(wiring, /financeRead:\s*createFinanceAuthorizationMiddleware\(FINANCE_PERMISSIONS\.READ\)/);
  assert.match(wiring, /financeWrite:\s*createFinanceAuthorizationMiddleware\(FINANCE_PERMISSIONS\.WRITE\)/);
  assert.doesNotMatch(wiring, /finance(?:Read|Write):\s*requireFinance/);
});

test('append-only attachment enforces finance/current lifecycle and owner isolation', async t => {
  const f = await registerFixture(t);
  const [root, version, personal] = f.entries;
  const base = { documentId: root.sha256, versionId: root.sha256, documentRole: 'invoice' };
  assert.throws(() => f.register.attachExpenseDocument(f.scope, f.expense,
    { ...base, documentId: 'f'.repeat(64), versionId: 'f'.repeat(64) }), /GED_DOCUMENT_NOT_APPROVED/);
  assert.throws(() => f.register.attachExpenseDocument(f.scope, f.expense,
    { ...base, documentId: personal.sha256, versionId: personal.sha256 }), /GED_VERSION_NOT_APPROVED/);
  await assert.rejects(f.register.attachExpenseDocument({ ...f.scope, owner: digest('other') }, f.expense, base),
    /GED_NOT_FOUND/);
  await f.register.lifecycle.mutate(f.scope, root.sha256,
    { action: 'version', expectedRevision: 0, versionId: version.sha256 });
  await assert.rejects(f.register.attachExpenseDocument(f.scope, f.expense, base), /GED_VERSION_CONFLICT/);
  const current = { ...base, versionId: version.sha256, externalReference: 'INV-2026-001' };
  const first = await f.register.attachExpenseDocument(f.scope, f.expense, current);
  assert.equal(first.created, true);
  // PGlite serializes one embedded connection: this is an idempotent collision
  // smoke test, not proof of PostgreSQL multi-session lock scheduling.
  const retries = await Promise.all(Array.from({ length: 8 }, () =>
    f.register.attachExpenseDocument(f.scope, f.expense, current)));
  assert.equal(retries.every(result => result.created === false), true);
  await f.db.query("SELECT set_config('m3s.tenant',$1,false),set_config('m3s.owner',$2,false)",
    [f.scope.tenant, f.scope.owner]);
  assert.equal((await f.db.query('SELECT * FROM ged_private.expense_document_links')).rows.length, 1);
  await f.register.lifecycle.mutate(f.scope, root.sha256, { action: 'trash', expectedRevision: 1 });
  await assert.rejects(f.register.attachExpenseDocument(f.scope, f.expense, current), /GED_DOCUMENT_TRASHED/);
});

test('HTTP attachment requires read, write, same origin and exposes lifecycle capability', async t => {
  const f = await registerFixture(t);
  const root = f.entries[0];
  let denyRead = false;
  let denyWrite = false;
  let missingExpense = false;
  const app = express();
  app.use('/api/ged/private', createGedRouter({ policy: f.policy,
    authenticate(req, _res, next) {
      req.user = { id: f.policy.owner.userId, tenantId: f.policy.owner.organizationId, authProvider: 'google' };
      next();
    },
    financeRead: (_req, res, next) => denyRead ? res.sendStatus(403) : next(),
    financeWrite: (_req, res, next) => denyWrite ? res.sendStatus(403) : next(),
    canFinanceWrite: () => !denyWrite,
    resolveExpense: async id => !missingExpense && id === f.expense.id ? f.expense : null,
    getServices: async () => ({ register: f.register, storage: {} })
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = 'https://seneswiss-group.com';
  const documentsUrl = `http://127.0.0.1:${server.address().port}/api/ged/private/documents`;
  const url = `http://127.0.0.1:${server.address().port}/api/ged/private/expenses/${f.expense.id}/documents`;
  const body = JSON.stringify({ documentId: root.sha256, versionId: root.sha256, documentRole: 'invoice' });
  const send = (headers = { origin, 'content-type': 'application/json' }, requestBody = body) =>
    fetch(url, { method: 'POST', headers, body: requestBody });
  const listed = await (await fetch(documentsUrl)).json();
  assert.deepEqual(listed.capabilities, { expenseAttach: true });
  denyRead = true; assert.equal((await send()).status, 403); denyRead = false;
  denyWrite = true;
  assert.deepEqual((await (await fetch(documentsUrl)).json()).capabilities, { expenseAttach: false });
  assert.equal((await send()).status, 403); denyWrite = false;
  assert.equal((await send({ 'content-type': 'application/json' })).status, 403);
  assert.equal((await send({ origin: 'https://foreign.example', 'content-type': 'application/json' })).status, 403);
  assert.equal((await send(undefined, JSON.stringify({ ...JSON.parse(body), unexpected: true }))).status, 400);
  assert.equal((await send(undefined, '{')).status, 400);
  assert.equal((await send(undefined, JSON.stringify({ externalReference: 'x'.repeat(3000) }))).status, 413);
  missingExpense = true; assert.equal((await send()).status, 404); missingExpense = false;
  let response = await send(); assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { success: true, created: true, link: {
    expenseId: f.expense.id, documentId: root.sha256, versionId: root.sha256,
    documentRole: 'invoice', externalReference: null, revision: 1 } });
  response = await send(); assert.equal(response.status, 200); assert.equal((await response.json()).created, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { once } = require('node:events');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { digest } = require('../gedPrivatePolicy');
const { createRegister } = require('../gedPrivateRegister');
const { createGedRouter, assertDatabaseAccess } = require('../gedPrivate');
const { transition, validateTitle } = require('../gedLifecycle');

test('strict title and command validation, no permanent deletion or owner change', () => {
  const current = { documentId: digest('root'), currentDocumentId: digest('root'), revision: 0, title: 'CV', trashed: false };
  for (const title of ['', ' space ', '<script>', 'line\nline', 'x'.repeat(141)]) assert.equal(validateTitle(title), false);
  assert.equal(validateTitle('CV actualisé – Zürich'), true);
  for (const command of [{ action: 'delete', expectedRevision: 0 }, { action: 'trash', expectedRevision: 0, owner: 'other' },
    { action: 'rename', expectedRevision: 0, title: '' }, { action: 'trash', expectedRevision: 1 }, { action: 'restore', expectedRevision: 0 }]) {
    assert.throws(() => transition(current, command));
  }
});

async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(readFileSync(require.resolve('../sql/ged-private-v1.sql'), 'utf8'));
  await db.exec(`CREATE ROLE m3s_ged_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT USAGE ON SCHEMA ged_private TO m3s_ged_app;
    GRANT SELECT, INSERT ON ged_private.documents TO m3s_ged_app;
    GRANT INSERT ON ged_private.events TO m3s_ged_app;`);
  await db.exec(readFileSync(require.resolve('../sql/ged-lifecycle-v2.sql'), 'utf8'));
  await db.exec('SET ROLE m3s_ged_app');
  await assertDatabaseAccess({ query: sql => db.query(sql) }, true);
  const entries = ['Original', 'Version', 'Invoice'].map((name, index) => {
    const bytes = Buffer.from('%PDF-1.4\nSYNTHETIC ' + name + '\n%%EOF');
    return { name: name + '.pdf', sha256: digest(bytes), size: bytes.length, category: index === 2 ? 'finance' : 'personal', bytes };
  });
  const policy = { owner: { userId: 'synthetic-user', organizationId: 'synthetic-org' }, documents: entries };
  const scope = { tenant: digest(policy.owner.organizationId), owner: digest(policy.owner.userId) };
  const register = createRegister({ connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }, { lifecyclePolicy: policy });
  for (const entry of entries) await register.create(scope, entry, '1234567890');
  return { db, entries, policy, scope, register, id: entries[0].sha256, versionId: entries[1].sha256 };
}

test('persistent rename, version, trash, restore; originals remain immutable', async t => {
  const f = await fixture(t); const { register: r, scope: s, id, versionId } = f;
  let row = await r.lifecycle.mutate(s, id, { action: 'rename', title: 'My updated CV', expectedRevision: 0 });
  assert.equal(row.title, 'My updated CV'); assert.equal(row.filename, 'Original.pdf');
  await assert.rejects(r.lifecycle.mutate(s, id, { action: 'trash', expectedRevision: 0 }), /GED_VERSION_CONFLICT/);
  row = await r.lifecycle.mutate(s, id, { action: 'version', versionId, expectedRevision: 1 });
  assert.equal(row.document_id, versionId); assert.equal(row.root_id, id);
  assert.equal((await r.lifecycle.list(s)).length, 2);
  assert.equal((await r.list(s)).length, 3);
  assert.equal((await r.read(s, id)).filename, 'Original.pdf');
  await assert.rejects(r.lifecycle.mutate(s, versionId, { action: 'trash', expectedRevision: 0 }), /GED_VERSION_NOT_ROOT/);
  row = await r.lifecycle.mutate(s, id, { action: 'trash', expectedRevision: 2 }); assert.equal(row.trashed, true);
  await assert.rejects(r.lifecycle.mutate(s, id, { action: 'rename', title: 'No', expectedRevision: 3 }), /GED_DOCUMENT_TRASHED/);
  row = await r.lifecycle.mutate(s, id, { action: 'restore', expectedRevision: 3 }); assert.equal(row.trashed, false);
  const history = await r.lifecycle.history(s, id);
  assert.deepEqual(history.map(e => e.action), ['import','rename','version','trash','restore']);
  assert.equal(history[0].row.document_id, id); assert.equal(history[2].row.document_id, versionId);
  await assert.rejects(f.db.query('DELETE FROM ged_private.revisions'), /permission denied/);
  await assert.rejects(f.db.query("UPDATE ged_private.revisions SET title='tamper'"), /permission denied/);
  await assert.rejects(f.db.query('TRUNCATE ged_private.revisions'), /permission denied/);
});

test('scope isolation and cross-category/version reuse rejected', async t => {
  const f = await fixture(t); const r = f.register;
  const foreign = { ...f.scope, owner: digest('other') };
  assert.deepEqual(await r.lifecycle.list(foreign), []);
  await assert.rejects(r.lifecycle.history(foreign, f.id), /GED_NOT_FOUND/);
  await assert.rejects(r.lifecycle.mutate(foreign, f.id, { action: 'trash', expectedRevision: 0 }), /GED_NOT_FOUND/);
  await assert.rejects(r.lifecycle.mutate(f.scope, f.id, { action: 'version', versionId: f.entries[2].sha256, expectedRevision: 0 }), /GED_VERSION_NOT_APPROVED/);
  await r.lifecycle.mutate(f.scope, f.versionId, { action: 'rename', title: 'Other dossier', expectedRevision: 0 });
  await assert.rejects(r.lifecycle.mutate(f.scope, f.id, { action: 'version', versionId: f.versionId, expectedRevision: 0 }), /GED_VERSION_ALREADY_LINKED/);
  assert.equal((await f.db.query('SELECT * FROM ged_private.revisions')).rows.length, 0);
});

test('real HTTP actions require authentication/origin and return persistent history', async t => {
  const f = await fixture(t); const app = express();
  app.use('/api/ged/private', createGedRouter({ policy: f.policy,
    authenticate(req, res, next) {
      if (req.get('authorization') !== 'Bearer synthetic') return res.status(401).end();
      req.user = { id: f.policy.owner.userId, tenantId: f.policy.owner.organizationId, authProvider: 'google' }; next();
    }, getServices: async () => ({ register: f.register, storage: { get: async ref => f.entries.find(e => e.sha256 === ref.sha256).bytes } }) }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/ged/private/documents/${f.id}`;
  const headers = { authorization: 'Bearer synthetic', origin: 'https://seneswiss-group.com', 'content-type': 'application/json' };
  const body = JSON.stringify({ action: 'rename', title: 'Updated', expectedRevision: 0 });
  assert.equal((await fetch(url + '/actions', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await fetch(url + '/actions', { method: 'POST', body, headers: { ...headers, origin: 'https://foreign.test' } })).status, 403);
  const good = await fetch(url + '/actions', { method: 'POST', body, headers }); assert.equal(good.status, 200);
  assert.equal((await good.json()).document.title, 'Updated');
  assert.equal((await fetch(url + '/actions', { method: 'POST', body, headers })).status, 409);
  const history = await (await fetch(url + '/history', { headers })).json(); assert.equal(history.history.length, 2);
});

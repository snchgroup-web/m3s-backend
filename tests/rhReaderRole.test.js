'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const readSql = name => fs.readFileSync(path.join(__dirname, '../sql', name), 'utf8');
const migration = readSql('rh-private-v1.sql');
const role = readSql('rh-reader-role-v1.sql');

test('maintenance creates a non-login reader without changing other rights or data', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE SCHEMA ged_private; CREATE TABLE ged_private.documents(id integer);');
  await db.exec(migration); await db.exec(role);
  const row = (await db.query("SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolinherit,rolconnlimit FROM pg_roles WHERE rolname='m3s_rh_reader'")).rows[0];
  assert.deepEqual(row, { rolcanlogin: false, rolsuper: false, rolcreaterole: false,
    rolcreatedb: false, rolbypassrls: false, rolinherit: false, rolconnlimit: 2 });
  await db.exec('SET ROLE m3s_rh_reader');
  assert.equal((await db.query('SELECT * FROM rh_private.employees')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM rh_private.entitlement_revisions')).rows.length, 0);
  await assert.rejects(db.exec('SELECT * FROM rh_private.creation_requests'));
  await assert.rejects(db.exec('SELECT * FROM ged_private.documents'));
  await assert.rejects(db.exec('DELETE FROM rh_private.employees'));
  await assert.rejects(db.exec('CREATE TABLE rh_private.forbidden(id integer)'));
  await assert.rejects(db.exec('ALTER ROLE m3s_rh_reader LOGIN'));
});

test('unexpected public data access aborts role creation transactionally', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(migration);
  await db.exec('CREATE TABLE public.other_data(id integer); GRANT SELECT ON public.other_data TO PUBLIC;');
  await assert.rejects(db.exec(role), /Unexpected RH reader privileges/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='m3s_rh_reader'")).rows[0].n, 0);
});

test('missing RLS and a repeated role installation are refused', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(migration);
  await db.exec('ALTER TABLE rh_private.employees DISABLE ROW LEVEL SECURITY');
  await assert.rejects(db.exec(role), /prerequisites not qualified/);
  await db.exec('ROLLBACK; ALTER TABLE rh_private.employees ENABLE ROW LEVEL SECURITY');
  await db.exec(role);
  await assert.rejects(db.exec(role), /prerequisites not qualified/);
  await db.exec('ROLLBACK');
});

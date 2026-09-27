const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { createRegister } = require('../gedPrivateRegister');

test('candidate expense links preserve files, support multiple proofs and isolate owners', async () => {
  const db = new PGlite();
  const tenant = 'a'.repeat(64), owner = 'b'.repeat(64), other = 'c'.repeat(64);
  const invoice = 'd'.repeat(64), receipt = 'e'.repeat(64);
  try {
    await db.exec(readFileSync(require.resolve('../sql/ged-private-v1.sql'), 'utf8'));
    await db.exec(readFileSync(require.resolve('../sql/ged-expense-links-candidate.sql'), 'utf8'));
    for (const id of [invoice, receipt]) await db.query(`INSERT INTO ged_private.documents
      (tenant,owner_id,document_id,filename,byte_size,generation) VALUES($1,$2,$3,'Synthetic.pdf',20,'1')`, [tenant, owner, id]);
    await db.exec(`CREATE ROLE link_test NOLOGIN;
      GRANT USAGE ON SCHEMA ged_private TO link_test;
      GRANT SELECT, INSERT ON ged_private.expense_document_links TO link_test;
      SET ROLE link_test;`);
    const scope = who => db.query("SELECT set_config('m3s.tenant',$1,false),set_config('m3s.owner',$2,false)", [tenant, who]);
    const link = (id, revision = 1, action = 'attach', who = owner) => db.query(`INSERT INTO ged_private.expense_document_links
      (tenant,owner_id,expense_source,expense_id,document_id,document_version_id,revision,action,document_role)
      VALUES($1,$2,'synthetic.expenses','DEP-SYNTHETIC',$3,$3,$4,$5,'invoice')`, [tenant, who, id, revision, action]);
    await scope(owner);
    await link(invoice); await link(receipt);
    await assert.rejects(link(invoice));
    await link(invoice, 2, 'detach');
    assert.equal((await db.query('SELECT * FROM ged_private.expense_document_links')).rows.length, 3);
    const register = createRegister({ connect: async () => ({ query: (sql,params)=>db.query(sql,params), release() {} }) });
    const active = await register.expenseLinks({tenant,owner},'synthetic.expenses','DEP-SYNTHETIC');
    assert.equal(active.length,1);
    assert.equal(active[0].document_id,receipt);
    assert.deepEqual(await register.expenseLinks({tenant,owner},'another.source','DEP-SYNTHETIC'),[]);
    await assert.rejects(db.exec('DELETE FROM ged_private.expense_document_links'));
    await assert.rejects(db.exec("UPDATE ged_private.expense_document_links SET expense_id='changed'"));
    await scope(other);
    assert.equal((await db.query('SELECT * FROM ged_private.expense_document_links')).rows.length, 0);
    await assert.rejects(link(receipt, 2));
    await assert.rejects(link(receipt, 1, 'attach', other));
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT * FROM ged_private.documents')).rows.length, 2);
  } finally { await db.close(); }
});

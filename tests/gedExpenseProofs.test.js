const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createGedRouter } = require('../gedPrivate');
const { readPolicy, digest } = require('../gedPrivatePolicy');

test('expense proofs enforce owner, finance, exact expense, financial scope, trash and pinned versions', async () => {
  const bytes = Buffer.from('%PDF-1.4\nsynthetic expense proof\n%%EOF');
  const id = digest(bytes), owner = { userId: 'synthetic', organizationId: 'synthetic-org' };
  const policy = readPolicy({ M3S_GED_PRIVATE_ENABLED: 'true', M3S_IDENTITY_MODE: 'google', API_REQUIRE_AUTH: 'true',
    M3S_GED_OWNER_JSON: JSON.stringify(owner), M3S_IDENTITY_BINDING_JSON: JSON.stringify({ ...owner, active: true }),
    M3S_GED_IMPORT_MANIFEST_JSON: JSON.stringify([{ name: 'Proof.pdf', sha256: id, size: bytes.length, category: 'finance' }]) });
  let denied = false, otherOwner = false, missing = false, trashed = false, linked = true, invalidVersion = false, downloads = 0;
  const row = { document_id: id, filename: 'Proof.pdf', byte_size: bytes.length, generation: '1', root_id: id };
  const app = express();
  app.use(createGedRouter({ policy,
    authenticate: (req, _res, next) => { req.user = { id: otherOwner ? 'other' : owner.userId, tenantId: owner.organizationId, authProvider: 'google', role: 'Manager' }; next(); },
    financeRead: (_req,res,next) => denied ? res.sendStatus(403) : next(),
    resolveExpense: async key => !missing && key==='DEP-SYNTH' ? { id:key,source:'synthetic.expenses' } : null,
    getServices: async () => ({ register: {
      expenseLinks: async (_scope,source,key) => { assert.equal(source,'synthetic.expenses'); assert.equal(key,'DEP-SYNTH'); return linked ? [{document_id:id,document_version_id:invalidVersion?'f'.repeat(64):id,document_role:'invoice',revision:1}] : []; },
      lifecycle: { list: async()=>[{...row,trashed}], history:async()=>[{current_document_id:id}] },
      read:async()=>row, auditDownload:async()=>{ downloads++; }
    }, storage:{get:async()=>bytes} }) }));
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  const url = `http://127.0.0.1:${server.address().port}/expenses/DEP-SYNTH/documents`;
  try {
    let res = await fetch(url); assert.equal(res.status,200); assert.equal((await res.json()).documents[0].id,id);
    res = await fetch(url+'/'+id+'/content'); assert.equal(res.status,200); assert.equal(await res.text(),bytes.toString()); assert.equal(downloads,1);
    denied=true; assert.equal((await fetch(url)).status,403); denied=false;
    otherOwner=true; assert.equal((await fetch(url)).status,403); otherOwner=false;
    missing=true; assert.equal((await fetch(url)).status,404); missing=false;
    trashed=true; assert.deepEqual((await (await fetch(url)).json()).documents,[]); assert.equal((await fetch(url+'/'+id+'/content')).status,404); trashed=false;
    linked=false; assert.equal((await fetch(url+'/'+id+'/content')).status,404); linked=true;
    invalidVersion=true; assert.notEqual((await fetch(url+'/'+id+'/content')).status,200);
    assert.equal(downloads,1);
  } finally { server.close(); await once(server,'close'); }
});

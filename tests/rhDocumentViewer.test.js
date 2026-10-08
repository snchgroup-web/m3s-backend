'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { createViewerRuntime } = require('../rhDocumentViewer');
const { assertViewerAccess } = require('../rhDocumentViewer');
const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const path = '/employees/11111111-1111-4111-8111-111111111111/contract-documents?dossierRevision=2';
test('viewer fails closed, preserves unrelated routes and refuses before SQL', async t => {
  let connections = 0;
  const app = express();
  const runtime = createViewerRuntime({enabled:true,origins:['https://synthetic.example'],
    identityRuntime:{mode:'google',authenticate(req,res,next){next();}},
    pool:{connect(){connections++;throw Error('secret provider detail');}},getStore:async()=>({})});
  app.use(runtime);
  app.get('/employees', (req,res)=>res.json({existing:true}));
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const url = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(url+path);
  assert.equal(response.status,403);
  response = await fetch(url+path,{headers:{Origin:'https://synthetic.example'}});
  assert.equal(response.status,401);
  assert.equal(connections,0);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  response = await fetch(url+'/employees');
  assert.deepEqual(await response.json(),{existing:true});
});
test('disabled viewer does not authenticate or connect', async t => {
  const app = express();
  app.use(createViewerRuntime({identityRuntime:{authenticate(){throw Error('must not run');}}}));
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{code:'RH_DOCUMENT_NOT_ENABLED'});
});
test('SQL viewer reads exact private PDF, rejects revocation, scope and ACL drift', async t => {
  const db = new PGlite(); await db.waitReady;
  t.after(()=>db.close());
  for (const name of ['rh-private-v1.sql','rh-reader-role-v1.sql']) {
    await db.exec(readFileSync(resolve(__dirname,'../sql',name),'utf8'));
  }
  for (const name of ['rh-contract-documents-candidate.sql','rh-document-sources-candidate.sql','rh-document-original-sources-candidate.sql']) {
    await db.exec(readFileSync(resolve(__dirname,'fixtures',name),'utf8'));
  }
  const user = {id:'synthetic-viewer',tenantId:'synthetic-org',authProvider:'google'};
  const hash = x => createHash('sha256').update(x).digest('hex');
  const scope = [hash(user.tenantId),hash(user.id)];
  const employee = '11111111-1111-4111-8111-111111111111';
  const bytes = Buffer.from('%PDF-1.7\nsynthetic fixture');
  const documentId = hash(bytes);
  const args = [...scope,employee,documentId,documentId];
  await db.query('INSERT INTO rh_private.employees(tenant,owner_id,employee_id) VALUES($1,$2,$3)',[...scope,employee]);
  await db.query(`INSERT INTO rh_private.employee_revisions(tenant,owner_id,employee_id,revision,display_name,record_status,classification)
    VALUES($1,$2,$3,2,'SYNTHETIC','draft','C3')`,[...scope,employee]);
  await db.query(`INSERT INTO rh_private.entitlement_revisions(tenant,owner_id,revision,can_read,decision_ref)
    VALUES($1,$2,1,true,'SYNTHETIC')`,scope);
  await db.query(`INSERT INTO rh_private.contract_document_metadata_revisions
    (tenant,owner_id,employee_id,dossier_revision,document_id,version_id,purpose,metadata_revision,category,classification,record_status,trashed,source_ref)
    VALUES($1,$2,$3,2,$4,$5,'contract_draft',1,'rh','C3','draft',false,'SYNTHETIC')`,args);
  await db.query(`INSERT INTO rh_private.contract_document_original_revisions
    (tenant,owner_id,employee_id,dossier_revision,document_id,version_id,catalog_revision,metadata_revision,sha256,byte_size,object_generation,content_type,withdrawn,source_ref)
    VALUES($1,$2,$3,2,$4,$5,1,1,$4,$6,'123','application/pdf',false,'SYNTHETIC')`,[...args,bytes.length]);
  await db.query(`INSERT INTO rh_private.document_original_decision_revisions
    (tenant,owner_id,employee_id,dossier_revision,document_id,version_id,purpose,revision,can_verify_original,decision_ref)
    VALUES($1,$2,$3,2,$4,$5,'contract_draft',1,true,'SYNTHETIC')`,args);
  await db.query(`INSERT INTO rh_private.contract_documents(tenant,owner_id,document_id,employee_id) VALUES($1,$2,$3,$4)`,[...scope,documentId,employee]);
  await db.query(`INSERT INTO rh_private.contract_document_links
    (tenant,owner_id,employee_id,dossier_revision,document_id,version_id,purpose,category,classification,record_status,trashed)
    VALUES($1,$2,$3,2,$4,$5,'contract_draft','rh','C3','draft',false)`,args);
  await db.exec(`CREATE ROLE m3s_rh_document_viewer NOLOGIN NOINHERIT;
    GRANT USAGE ON SCHEMA rh_private TO m3s_rh_document_viewer;
    GRANT SELECT ON rh_private.schema_versions,rh_private.entitlement_revisions,rh_private.employee_revisions,
    rh_private.contract_document_links,rh_private.contract_document_metadata_revisions,
    rh_private.contract_document_original_revisions,rh_private.document_original_decision_revisions TO m3s_rh_document_viewer;
    SET ROLE m3s_rh_document_viewer;`);
  const pool = {connect:async()=>({query:(sql,params)=>db.query(sql,params),release(){}})};
  await assertViewerAccess(await pool.connect());
  let reads = 0, corrupt = false;
  const app = express();
  app.use(createViewerRuntime({enabled:true,pool,origins:['https://synthetic.example'],
    identityRuntime:{mode:'google',authenticate(req,res,next){req.user=req.get('X-Foreign')?{...user,id:'other'}:user;next();}},
    getStore:async()=>({get:async value=>{reads++;assert.equal(value.generation,'123');assert.equal(value.sha256,documentId);
      return corrupt?Buffer.from('invalid'):bytes;}})}));
  const server = app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const prefix = `http://127.0.0.1:${server.address().port}/employees/${employee}/contract-documents`;
  const request = (suffix='',headers={})=>fetch(`${prefix}${suffix}?dossierRevision=2`,{headers:{Origin:'https://synthetic.example',...headers}});
  let response = await request();assert.equal(response.status,200);
  assert.equal((await response.json()).documents.length,1);
  response=await request(`/${documentId}/versions/${documentId}`);assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  assert.equal(response.headers.get('content-type'),'application/pdf');
  assert.equal((await request('',{'X-Foreign':'true'})).status,403);
  corrupt=true;assert.equal((await request(`/${documentId}/versions/${documentId}`)).status,503);corrupt=false;
  const before=reads;
  await db.exec('RESET ROLE');
  await db.query(`INSERT INTO rh_private.document_original_decision_revisions
    (tenant,owner_id,employee_id,dossier_revision,document_id,version_id,purpose,revision,can_verify_original,decision_ref)
    VALUES($1,$2,$3,2,$4,$5,'contract_draft',2,false,'SYNTHETIC-REVOKE')`,args);
  await db.exec('SET ROLE m3s_rh_document_viewer');
  assert.equal((await request(`/${documentId}/versions/${documentId}`)).status,403);
  assert.equal(reads,before);
  assert.deepEqual((await (await request()).json()).documents,[]);
  await db.exec('RESET ROLE; GRANT UPDATE ON rh_private.contract_document_links TO m3s_rh_document_viewer; SET ROLE m3s_rh_document_viewer');
  await assert.rejects(assertViewerAccess(await pool.connect()),/RH_DOCUMENT_SOURCE_UNAVAILABLE/);
});

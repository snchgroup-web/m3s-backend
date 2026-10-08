'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {once}=require('node:events');
const {createQualifiedReturnRuntime}=require('../rhReturns/rh-return-runtime.cjs');
const {createReturnContextReader}=require('../rhReturns/rh-return-context.cjs');
test('context route authenticates, derives scope and never calls the writer',async t=>{
  let reads=0,writes=0;
  const app=express();
  app.use(createQualifiedReturnRuntime({qualified:true,identityRuntime:{mode:'google',authenticate(req,res,next){if(req.get('Authorization')==='Bearer synthetic')req.user={id:'synthetic',tenantId:'synthetic-org',authProvider:'google'};next();}},
    readBindings:async()=>[{userId:'synthetic',organizationId:'synthetic-org',permissions:['read']}],
    observeBatch:async()=>{writes++;},readContext:async(scope,inputs)=>{reads++;assert.match(scope.actor,/^[a-f0-9]{64}$/);return {target:inputs[0],paymentConfirmed:false};}}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url=`http://127.0.0.1:${server.address().port}/returns/context`;
  const headers={'Content-Type':'application/json',Origin:'https://seneswiss-group.com'};
  assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,401);
  headers.Authorization='Bearer synthetic';
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://other.test'},body:'{}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({target:{employeeId:'synthetic'},scope:'injected'})})).status,400);
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({target:{employeeId:'synthetic'}})});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(reads,1);assert.equal(writes,0);
});
test('context reader refuses malformed requests before any connection',async()=>{
  let connections=0;const read=createReturnContextReader({connect(){connections++;throw Error('unexpected');}},{});
  for(const value of [[],[{}],[{employeeId:'bad',dossierRevision:2,period:'2026-09',kind:'salary'}],[{employeeId:'11111111-1111-4111-8111-111111111111',dossierRevision:2,period:'2026-13',kind:'salary'}]])await assert.rejects(read({},value));
  assert.equal(connections,0);
});
test('context reads under enforced role and scope, rejects denied and stale targets without writes',async()=>{
  const statements=[];let allowed=true,revision=2,releases=0;
  const client={release(){releases++;},async query(sql,params){
    statements.push(sql);
    if(sql.includes('current_user AS role'))return {rows:[{role:'m3s_rh_return_writer',memberships:0,rolcanlogin:false,rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false}]};
    if(sql.includes('c.relname,c.relkind'))return {rows:params[0].map(relname=>({relname,relkind:'r',relrowsecurity:true,relforcerowsecurity:true,owns_table:false,can_create:false,can_use:true,can_read:true,can_change:false,can_add:relname==='return_observations'}))};
    if(sql.includes('AS exposed'))return {rows:[{exposed:false}]};
    if(sql.includes('SELECT revision,display_name'))return {rows:[{revision,display_name:'SYNTHETIC',classification:'C3',record_status:'draft'}]};
    if(sql.includes('SELECT observation_revision'))return {rows:[{observation_revision:3}]};
    return {rows:[]};
  }};
  const read=createReturnContextReader({connect:async()=>client},{authorizeObservation:async()=>allowed,resolveExpectation:async()=>({employeeName:'SYNTHETIC',workerKey:'synthetic',amountXof:50000,sourceRef:'SYNTHETIC.EXPECTED'})});
  const scope={tenant:'a'.repeat(64),owner:'b'.repeat(64),actor:'c'.repeat(64)};
  const target={employeeId:'11111111-1111-4111-8111-111111111111',dossierRevision:2,period:'2026-09',kind:'salary'};
  const result=await read(scope,[target]);assert.equal(result.expectedPreviousRevision,3);assert.equal(result.paymentConfirmed,false);
  allowed=false;await assert.rejects(read(scope,[target]),/OBSERVATION_DENIED/);
  allowed=true;revision=3;await assert.rejects(read(scope,[target]),/STALE_DOSSIER/);
  assert.equal(releases,3);assert.ok(statements.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(statements.every(sql=>!/^INSERT|^UPDATE|^DELETE|^CREATE|^GRANT/.test(sql)));
});

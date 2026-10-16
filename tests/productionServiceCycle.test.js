'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {setup,advance,principal}=require('../productionServiceModel');
const {createProductionServiceStore}=require('../productionServiceStore');
const {createProductionServiceRouter,createProductionServiceHost,productionDatabaseOptions,assertProductionConnector}=require('../productionServiceRuntime');
const express=require('express');
const {once}=require('node:events');
const user={id:'synthetic-operator',tenantId:'synthetic-tenant',authProvider:'google'};
const preparation={track:'documents',scope:'Synthetic delivery',owner:'Synthetic function',authorization_reference:'CADRAGE-TEST'};
const real={step:'realization',occurred_on:'2026-10-12',evidence_reference:'PROOF-TEST',deliverable_reference:'DELIVERABLE-TEST',version:'V1'};
const delivery={step:'delivery',occurred_on:'2026-10-13',evidence_reference:'HANDOVER-TEST',recipient:'Synthetic recipient',channel:'email'};
const accepted={step:'acceptance',occurred_on:'2026-10-14',evidence_reference:'RETURN-TEST',recipient:'Synthetic recipient',outcome:'accepted'};
async function fixture(t,dataDir) {
  const db=new PGlite(dataDir);await db.waitReady;let closed=false;
  const close=async()=>{if(!closed){closed=true;await db.close();}};t.after(close);
  const ddl=await fs.readFile(path.join(__dirname,'../sql/production_service_cycle_v1.sql'),'utf8');
  await db.exec(ddl);
  const scope=principal(user);
  await db.query('INSERT INTO production_private.access_decisions(tenant,actor,track,can_read,can_prepare,can_deliver,can_accept,active,decision_reference) VALUES($1,$2,$3,true,true,true,true,true,$4)',[scope.tenant,scope.actor,'documents','SYNTHETIC-DECISION']);
  const state={failUpdate:false};
  const pool={async connect(){await db.exec('SET ROLE m3s_production_service_app');return {query:(sql,params)=>{
    if(state.failUpdate&&sql.startsWith('UPDATE production_private.cycles'))throw Error('SYNTHETIC_UPDATE_FAILURE');
    return db.query(sql,params);
  },release(){}};}};
  const store=createProductionServiceStore({pool,validateSources:async()=>true,now:()=> '2026-10-17'});
  return {db,store,scope,state,close};
}
test('schema, RLS and least privileges do not touch RH/GED or grant default access',async t=>{
  const {db}=await fixture(t);
  const rows=(await db.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='production_private'::regnamespace AND relkind='r' ORDER BY relname")).rows;
  assert.equal(rows.length,4);assert(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
  assert.equal((await db.query("SELECT has_table_privilege('m3s_production_service_app','production_private.events','DELETE,UPDATE,TRUNCATE') allowed")).rows[0].allowed,false);
  assert.equal((await db.query("SELECT has_table_privilege('m3s_production_service_app','production_private.access_decisions','INSERT,UPDATE,DELETE') allowed")).rows[0].allowed,false);
  await db.exec('SET ROLE m3s_production_service_app');
  assert.equal((await db.query('SELECT * FROM production_private.access_decisions')).rows.length,0);
});
test('unexpected inherited default grants abort the whole migration',async t=>{
  const db=new PGlite();await db.waitReady;t.after(()=>db.close());
  await db.exec('CREATE ROLE synthetic_unrelated NOLOGIN; ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO synthetic_unrelated;');
  const ddl=await fs.readFile(path.join(__dirname,'../sql/production_service_cycle_v1.sql'),'utf8');
  await assert.rejects(db.exec(ddl),/SERVICE_UNEXPECTED_DEFAULT_GRANT/);await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT count(*)::int count FROM pg_namespace WHERE nspname='production_private'")).rows[0].count,0);
  assert.equal((await db.query("SELECT count(*)::int count FROM pg_roles WHERE rolname='m3s_production_service_app'")).rows[0].count,0);
});
test('create, retry, append, reload and acceptance persist with server audit',async t=>{
  const {store}=await fixture(t);const request=randomUUID();
  const first=await store.create(user,preparation,request);assert.equal(first.replayed,false);
  const retry=await store.create(user,preparation,request);assert.equal(retry.item.id,first.item.id);assert.equal(retry.replayed,true);
  await assert.rejects(store.create(user,{...preparation,scope:'Changed'},request),/SERVICE_CONFLICT/);
  let row=first.item;
  for(const event of [real,delivery,accepted])row=(await store.append(user,row.id,event,row.revision,randomUUID())).item;
  const read=await store.get(user,row.id);assert.equal(read.revision,3);assert.equal(read.events[2].delivery_event_index,1);
  assert.equal(read.audit.length,3);assert(read.audit.every(x=>x.actor===principal(user).actor));
  assert.equal(read.acceptance_kind,'reported_not_signed');assert.equal(read.references_verified,false);
  await assert.rejects(store.append(user,row.id,{...real,occurred_on:'2026-10-15'},3,randomUUID()),/SERVICE_TRANSITION/);
});
test('event retries are idempotent; stale/changed requests cannot add or overwrite',async t=>{
  const {store}=await fixture(t);const {item}=await store.create(user,preparation,randomUUID());const request=randomUUID();
  await store.append(user,item.id,real,0,request);
  assert.equal((await store.append(user,item.id,real,0,request)).replayed,true);
  await assert.rejects(store.append(user,item.id,{...real,version:'V2'},0,request),/SERVICE_CONFLICT/);
  await assert.rejects(store.append(user,item.id,delivery,0,randomUUID()),/SERVICE_CONFLICT/);
  assert.equal((await store.get(user,item.id)).revision,1);
});
test('dedicated rights isolate tenants, actors and paths; manager title grants nothing',async t=>{
  const {store}=await fixture(t);const {item}=await store.create(user,preparation,randomUUID());
  for(const other of [{...user,id:'other',role:'Manager'},{...user,tenantId:'other'},{...user,authProvider:'legacy'}]){
    await assert.rejects(store.access(other),/SERVICE_FORBIDDEN/);
    await assert.rejects(store.get(other,item.id),/SERVICE_NOT_FOUND|SERVICE_FORBIDDEN/);
  }
  await assert.rejects(store.list(user,'rh'),/SERVICE_FORBIDDEN/);
  await assert.rejects(store.create(user,{...preparation,track:'rh'},randomUUID()),/SERVICE_FORBIDDEN/);
});
test('delivery permission is distinct from preparation; revocation blocks subsequent requests',async t=>{
  const {db,store,scope}=await fixture(t);const {item}=await store.create(user,preparation,randomUUID());
  await store.append(user,item.id,real,0,randomUUID());
  await db.exec('RESET ROLE');await db.query('UPDATE production_private.access_decisions SET can_deliver=false WHERE tenant=$1 AND actor=$2',[scope.tenant,scope.actor]);
  await assert.rejects(store.append(user,item.id,delivery,1,randomUUID()),/SERVICE_FORBIDDEN/);
  assert.equal((await store.get(user,item.id)).revision,1);
  await db.exec('RESET ROLE');await db.query('UPDATE production_private.access_decisions SET active=false WHERE tenant=$1 AND actor=$2',[scope.tenant,scope.actor]);
  await assert.rejects(store.get(user,item.id),/SERVICE_NOT_FOUND/);
});
test('source unavailability fails before writing a record',async t=>{
  const {db,scope}=await fixture(t);
  const store=createProductionServiceStore({pool:{connect(){assert.fail('No database mutation');}},validateSources:async()=>false});
  await assert.rejects(store.create(user,preparation,randomUUID()),/SERVICE_SOURCE_UNAVAILABLE/);
  assert.equal((await db.query('SELECT * FROM production_private.cycles WHERE tenant=$1',[scope.tenant])).rows.length,0);
});
test('event and revision roll back together if the second write fails',async t=>{
  const {store,state}=await fixture(t);const {item}=await store.create(user,preparation,randomUUID());const request=randomUUID();
  state.failUpdate=true;await assert.rejects(store.append(user,item.id,real,0,request),/SYNTHETIC_UPDATE_FAILURE/);
  const unchanged=await store.get(user,item.id);assert.equal(unchanged.revision,0);assert.deepEqual(unchanged.events,[]);
  state.failUpdate=false;assert.equal((await store.append(user,item.id,real,0,request)).item.revision,1);
});
test('corrupt stored histories are unavailable, not accepted at face value',async t=>{
  const {db,store,scope}=await fixture(t);const {item}=await store.create(user,preparation,randomUUID());
  await store.append(user,item.id,real,0,randomUUID());await db.exec('RESET ROLE');
  await db.query("UPDATE production_private.events SET event=event||'{\"salary\":50000}'::jsonb WHERE tenant=$1 AND cycle_id=$2",[scope.tenant,item.id]);
  await assert.rejects(store.get(user,item.id),/SERVICE_UNAVAILABLE/);
});
test('a synthetic persisted database reopens with cycle, history and rights intact',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3s-production-synthetic-'));let reopened,first;
  try {
    first=await fixture(t,dir);let {item}=await first.store.create(user,preparation,randomUUID());
    item=(await first.store.append(user,item.id,real,0,randomUUID())).item;
    await first.close();reopened=new PGlite(dir);await reopened.waitReady;
    const pool={async connect(){await reopened.exec('SET ROLE m3s_production_service_app');return{query:(s,p)=>reopened.query(s,p),release(){}};}};
    const store=createProductionServiceStore({pool,validateSources:async()=>true,now:()=> '2026-10-17'});
    const restored=await store.get(user,item.id);assert.equal(restored.revision,1);assert.equal(restored.events[0].version,'V1');
    assert.equal((await store.access(user))[0].can_accept,true);
  } finally {
    if(first)await first.close();if(reopened)await reopened.close();
    if(path.resolve(path.dirname(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('m3s-production-synthetic-'))throw Error('Unsafe synthetic cleanup path');
    await fs.rm(dir,{recursive:true,force:true});
  }
});
test('connector checks the actual PostgreSQL role and refuses unrelated table grants',async t=>{
  for(const extra of ['none','table','column']){
    const {db}=await fixture(t);
    await db.exec(`CREATE ROLE m3s_production_service_connector LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
      GRANT m3s_production_service_app TO m3s_production_service_connector WITH INHERIT FALSE, SET TRUE;
      CREATE TABLE public.synthetic_private(value text);
      ${extra==='table'?'GRANT SELECT ON public.synthetic_private TO m3s_production_service_app;':extra==='column'?'GRANT SELECT(value) ON public.synthetic_private TO m3s_production_service_app;':''}
      SET SESSION AUTHORIZATION m3s_production_service_connector;`);
    if(extra!=='none')await assert.rejects(assertProductionConnector(db),/SERVICE_UNAVAILABLE/);
    else await assertProductionConnector(db);
  }
});

test('operator connector migration stays NOLOGIN until the separate credential handoff',async t=>{
  const {db}=await fixture(t);
  const ddl=await fs.readFile(path.join(__dirname,'../sql/production_service_connector_v1.sql'),'utf8');
  await db.exec(ddl);
  const row=(await db.query("SELECT rolcanlogin,rolconnlimit,rolinherit FROM pg_roles WHERE rolname='m3s_production_service_connector'")).rows[0];
  assert.deepEqual(row,{rolcanlogin:false,rolconnlimit:2,rolinherit:false});
  const membership=(await db.query("SELECT admin_option,inherit_option,set_option FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='m3s_production_service_connector')")).rows;
  assert.deepEqual(membership,[{admin_option:false,inherit_option:false,set_option:true}]);
  await db.exec('ALTER ROLE m3s_production_service_connector LOGIN; SET SESSION AUTHORIZATION m3s_production_service_connector;');
  await assertProductionConnector(db);
});

test('connector migration rolls back when PUBLIC exposes an unrelated table',async t=>{
  const {db}=await fixture(t);
  await db.exec('CREATE TABLE public.synthetic_public(value text); GRANT SELECT ON public.synthetic_public TO PUBLIC;');
  const ddl=await fs.readFile(path.join(__dirname,'../sql/production_service_connector_v1.sql'),'utf8');
  await assert.rejects(db.exec(ddl),/SERVICE_CONNECTOR_UNEXPECTED_ACCESS/);await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='m3s_production_service_connector'")).rows[0].n,0);
});
test('reservations require a fresh version and another handover',()=>{
  const r=advance([],real,'2026-10-17');const d=advance([r],delivery,'2026-10-17');
  const reserved=advance([r,d],{...accepted,outcome:'reserved',reservations:'Synthetic correction'},'2026-10-17');
  assert.throws(()=>advance([r,d,reserved],real,'2026-10-17'),/SERVICE_CHRONOLOGY/);
  assert.throws(()=>advance([r,d,reserved],{...real,occurred_on:'2026-10-15'},'2026-10-17'),/SERVICE_VERSION/);
  const newVersion=advance([r,d,reserved],{...real,occurred_on:'2026-10-15',version:'V2'},'2026-10-17');
  assert.throws(()=>advance([r,d,reserved,newVersion],{...accepted,occurred_on:'2026-10-16'},'2026-10-17'),/SERVICE_TRANSITION/);
});
for(const [name,value] of [['salary',{...preparation,salary:50000}],['events',{...preparation,events:[accepted]}],['local file',{...preparation,authorization_reference:'file:///private'}],['unknown track',{...preparation,track:'employees'}]])test(`rejects ${name}`,()=>assert.throws(()=>setup(value),/SERVICE_INVALID/));
for(const date of ['2026-02-30','2030-01-01','12/10/26'])test(`rejects invalid/future event date ${date}`,()=>assert.throws(()=>advance([],{...real,occurred_on:date},'2026-10-17'),/SERVICE_INVALID/));
async function http(t,options){const app=express();app.use(createProductionServiceRouter(options));const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));return `http://127.0.0.1:${server.address().port}`;}
test('disabled runtime cannot bootstrap a store or authorize by configuration alone',async t=>{
  const base=await http(t,{});const response=await fetch(base+'/access');assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');
  let pools=0;const host=createProductionServiceHost({env:{M3S_PRODUCTION_SERVICE_PROFILE:'service-cycle-v1'},identityRuntime:{mode:'legacy'},createPool(){pools++;}});await host.close();assert.equal(pools,0);
});
test('HTTP route enforces identity, origin, JSON limits and explicit requests',async t=>{
  const {store}=await fixture(t);const identityRuntime={mode:'google',authenticate(req,res,next){if(req.get('authorization')!=='Bearer synthetic')return res.status(401).end();req.user=user;next();}};
  const base=await http(t,{enabled:true,identityRuntime,store,origins:['https://example.test']});
  assert.equal((await fetch(base+'/access')).status,401);
  assert.equal((await fetch(base+'/',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:'{}'})).status,403);
  const headers={authorization:'Bearer synthetic',origin:'https://example.test','content-type':'application/json'};
  assert.equal((await fetch(base+'/',{method:'POST',headers,body:JSON.stringify({request_id:randomUUID(),preparation,tenant:'forged'})})).status,400);
  assert.equal((await fetch(base+'/',{method:'POST',headers,body:JSON.stringify({padding:'x'.repeat(9000)})})).status,413);
  const created=await fetch(base+'/',{method:'POST',headers,body:JSON.stringify({request_id:randomUUID(),preparation})});assert.equal(created.status,201);
  const result=await created.json();assert.equal(result.storage,'shared');assert.equal(result.item.revision,0);
});
test('database configuration pins TLS/host/pool and requires a distinct 32-character technical secret',()=>{
  const env={M3S_PRODUCTION_SERVICE_DB_PASSWORD:'S'.repeat(40),M3S_RH_DB_CA_PEM:'-----BEGIN CERTIFICATE-----\nsynthetic'};
  assert.equal(productionDatabaseOptions(env).ssl.rejectUnauthorized,true);assert.equal(productionDatabaseOptions(env).max,2);
  for(const patch of [{M3S_PRODUCTION_SERVICE_DB_PASSWORD:'short'},{M3S_RH_DB_CA_PEM:''},{M3S_GED_DB_PASSWORD:env.M3S_PRODUCTION_SERVICE_DB_PASSWORD}])assert.throws(()=>productionDatabaseOptions({...env,...patch}),/SERVICE_UNAVAILABLE/);
});

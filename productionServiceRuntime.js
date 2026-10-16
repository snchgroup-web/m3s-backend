'use strict';
const express = require('express');
const { SOURCES, fields, fail } = require('./productionServiceModel');
const { createProductionServiceStore } = require('./productionServiceStore');
const PREFIX='/api/production/service-cycles';
const isProductionServiceRoute=path=>typeof path==='string'&&(path.toLowerCase()===PREFIX||path.toLowerCase().startsWith(PREFIX+'/'));
const codes={SERVICE_FORBIDDEN:403,SERVICE_NOT_FOUND:404,SERVICE_INVALID:400,SERVICE_LIMIT:422,
  SERVICE_CONFLICT:409,SERVICE_TRANSITION:409,SERVICE_CHRONOLOGY:422,SERVICE_VERSION:422,
  SERVICE_RECIPIENT:422,SERVICE_UNAVAILABLE:503,SERVICE_SOURCE_UNAVAILABLE:503};
function createProductionServiceRouter({ enabled=false, identityRuntime, store, origins=[] }={}) {
  const allowed=new Set(origins);
  const router=express.Router();
  router.use((req,res,next)=> {
    res.set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff');
    if(!enabled||identityRuntime?.mode!=='google'||!store)return res.status(503).json({code:'SERVICE_NOT_ENABLED'});
    if((req.get('Origin')&&!allowed.has(req.get('Origin')))||(req.method!=='GET'&&!allowed.has(req.get('Origin'))))return res.status(403).json({code:'SERVICE_ORIGIN_DENIED'});
    Promise.resolve().then(()=>identityRuntime.authenticate(req,res,next)).catch(next);
  });
  router.use((req,res,next)=> {
    if(!req.user)return res.status(401).json({code:'SERVICE_AUTH_REQUIRED'});
    if(!['GET','POST'].includes(req.method))return res.status(405).set('Allow','GET, POST').json({code:'SERVICE_METHOD_DENIED'});
    if(req.get('Content-Encoding'))return res.status(415).json({code:'SERVICE_ENCODING_DENIED'});
    if(req.method==='POST'&&!req.is('application/json'))return res.status(415).json({code:'SERVICE_JSON_REQUIRED'});
    next();
  });
  router.use(express.json({limit:'8kb',strict:true}));
  const run=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
  const noQuery=req=>{if(Object.keys(req.query).length)fail('SERVICE_INVALID');};
  router.get('/access',run(async(req,res)=>{noQuery(req);res.json({items:await store.access(req.user),storage:'shared',acceptance_kind:'reported_not_signed'});}));
  router.get('/',run(async(req,res)=>{
    if(Object.keys(req.query).join(',')!=='track'||!Object.hasOwn(SOURCES,req.query.track))fail('SERVICE_INVALID');
    res.json({items:await store.list(req.user,req.query.track),storage:'shared'});
  }));
  router.get('/:id',run(async(req,res)=>{noQuery(req);res.json({item:await store.get(req.user,req.params.id),storage:'shared'});}));
  router.post('/',run(async(req,res)=>{
    noQuery(req);fields(req.body,['request_id','preparation']);
    const result=await store.create(req.user,req.body.preparation,req.body.request_id);
    res.status(result.replayed?200:201).json({...result,storage:'shared'});
  }));
  router.post('/:id/events',run(async(req,res)=>{
    noQuery(req);fields(req.body,['request_id','expected_revision','event']);
    const result=await store.append(req.user,req.params.id,req.body.event,req.body.expected_revision,req.body.request_id);
    res.status(result.replayed?200:201).json({...result,storage:'shared'});
  }));
  router.use((_req,res)=>res.status(404).json({code:'SERVICE_ROUTE_NOT_FOUND'}));
  router.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    if(error?.type==='entity.too.large')return res.status(413).json({code:'SERVICE_BODY_TOO_LARGE'});
    if(error?.type==='entity.parse.failed')return res.status(400).json({code:'SERVICE_INVALID_JSON'});
    const code=['40001','40P01','23505'].includes(error?.code)?'SERVICE_CONFLICT':Object.hasOwn(codes,error?.message)?error.message:'SERVICE_UNAVAILABLE';
    res.status(codes[code]).json({code});
  });
  return router;
}
function productionDatabaseOptions(env) {
  const password=env.M3S_PRODUCTION_SERVICE_DB_PASSWORD;
  const ca=env.M3S_RH_DB_CA_PEM;
  if(typeof password!=='string'||password.length<32||
    [env.M3S_GED_DB_PASSWORD,env.M3S_RH_DB_PASSWORD,env.M3S_RH_DOCUMENT_DB_PASSWORD,env.M3S_RH_RETURN_DB_PASSWORD].includes(password)||
    typeof ca!=='string'||!ca.includes('-----BEGIN CERTIFICATE-----'))fail('SERVICE_UNAVAILABLE');
  return {host:'postgres.railway.internal',port:5432,database:'railway',user:'m3s_production_service_connector',password,
    ssl:{ca,rejectUnauthorized:true},max:2,connectionTimeoutMillis:8000,idleTimeoutMillis:10000,
    statement_timeout:10000,query_timeout:12000,idle_in_transaction_session_timeout:15000,application_name:'m3s-production-service-cycle'};
}
async function assertProductionConnector(client) {
  await client.query('RESET ROLE');
  const result=await client.query(`SELECT rolname,rolcanlogin,rolconnlimit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) memberships,
    EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.roleid WHERE m.member=r.oid
      AND a.rolname='m3s_production_service_app' AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option) assumes_app
    FROM pg_roles r WHERE rolname=session_user`);
  const row=result.rows[0];
  if(result.rows.length!==1||row.rolname!=='m3s_production_service_connector'||!row.rolcanlogin||row.rolconnlimit!==2||row.memberships!==1||!row.assumes_app||
    ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','rolinherit'].some(k=>row[k]!==false))fail('SERVICE_UNAVAILABLE');
  const forbidden=await client.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    AND c.relkind IN ('r','v','m','p','f') AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user)
      OR has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`);
  if(forbidden.rows[0]?.count!==0)fail('SERVICE_UNAVAILABLE');
  await client.query('SET ROLE m3s_production_service_app');
  const app=await client.query(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) memberships FROM pg_roles r WHERE rolname=current_user`);
  if(app.rows.length!==1||app.rows[0].memberships!==0||
    ['rolcanlogin','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','rolinherit'].some(k=>app.rows[0][k]!==false))fail('SERVICE_UNAVAILABLE');
  const schema=await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='production_private' AND c.relkind='r' ORDER BY c.relname`);
  if(schema.rows.map(r=>r.relname).join(',')!=='access_decisions,cycles,events,schema_versions'||schema.rows.some(r=>!r.relrowsecurity||!r.relforcerowsecurity))fail('SERVICE_UNAVAILABLE');
  const extra=await client.query(`SELECT count(*)::int count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','v','m','p','f') AND
    (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR
      CASE WHEN n.nspname='production_private' AND c.relname IN ('cycles','events')
        THEN has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'REFERENCES')
        WHEN n.nspname='production_private' AND c.relname IN ('access_decisions','schema_versions')
        THEN has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')
        ELSE has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') END)`);
  if(extra.rows[0]?.count!==0)fail('SERVICE_UNAVAILABLE');
  const columns=await client.query(`SELECT table_name,column_name FROM information_schema.column_privileges
    WHERE grantee=current_user AND privilege_type='UPDATE' AND table_schema='production_private' ORDER BY table_name,column_name`);
  if(columns.rows.length!==1||columns.rows[0].table_name!=='cycles'||columns.rows[0].column_name!=='revision')fail('SERVICE_UNAVAILABLE');
  const create=await client.query(`SELECT count(*)::int count FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema')
    AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' AND has_schema_privilege(current_user,oid,'CREATE')`);
  if(create.rows[0]?.count!==0)fail('SERVICE_UNAVAILABLE');
}
function createProductionServiceHost({env={},identityRuntime,origins,validateSources,createPool=options=>new(require('pg').Pool)(options),warn=()=>{}}={}) {
  const closed=()=>({router:createProductionServiceRouter(),close:async()=>{}});
  if(env.M3S_PRODUCTION_SERVICE_PROFILE!=='service-cycle-v1'||identityRuntime?.mode!=='google')return closed();
  let pool;
  try {
    pool=createPool(productionDatabaseOptions(env));
    pool.on('error',()=>warn('SERVICE_POOL_UNAVAILABLE'));
    const guarded={async connect(){const client=await pool.connect();try{await assertProductionConnector(client);return client;}catch{client.release(true);fail('SERVICE_UNAVAILABLE');}}};
    const store=createProductionServiceStore({pool:guarded,validateSources});
    return {router:createProductionServiceRouter({enabled:true,identityRuntime,origins,store}),close:()=>pool.end()};
  } catch {if(pool?.end)Promise.resolve().then(()=>pool.end()).catch(()=>{});warn('SERVICE_CONFIGURATION_UNAVAILABLE');return closed();}
}
module.exports={PREFIX,isProductionServiceRoute,createProductionServiceRouter,productionDatabaseOptions,assertProductionConnector,createProductionServiceHost};

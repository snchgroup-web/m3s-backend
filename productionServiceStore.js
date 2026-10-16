'use strict';
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { setup, advance, principal, digest, fail } = require('./productionServiceModel');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('SERVICE_INVALID'); return value.toLowerCase(); }
function createProductionServiceStore({ pool, validateSources, now } = {}) {
  async function transaction(user, fn) {
    const scope = principal(user);
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='8s'");
      await client.query("SELECT set_config('m3s.production_tenant',$1,true),set_config('m3s.production_actor',$2,true)",[scope.tenant,scope.actor]);
      const versions = await client.query('SELECT version FROM production_private.schema_versions');
      if (versions.rows.length !== 1 || versions.rows[0].version !== 1) fail('SERVICE_UNAVAILABLE');
      const result = await fn(client, scope);
      await client.query('COMMIT');
      return result;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { broken=true; } throw error; }
    finally { client.release(broken); }
  }
  async function access(client, scope, track, permission) {
    const result = await client.query('SELECT can_read,can_prepare,can_deliver,can_accept FROM production_private.access_decisions WHERE tenant=$1 AND actor=$2 AND track=$3 AND active',[scope.tenant,scope.actor,track]);
    const grant = result.rows[0];
    if (result.rows.length !== 1 || grant.can_read !== true || grant[`can_${permission}`] !== true) fail('SERVICE_FORBIDDEN');
    return grant;
  }
  async function load(client, scope, id, locked = false) {
    const result = await client.query(`SELECT id,track,setup,revision FROM production_private.cycles WHERE tenant=$1 AND id=$2${locked?' FOR UPDATE':''}`,[scope.tenant,id]);
    if (result.rows.length !== 1) fail('SERVICE_NOT_FOUND');
    const row = result.rows[0];
    const history = await client.query('SELECT revision,event,actor,recorded_at FROM production_private.events WHERE tenant=$1 AND cycle_id=$2 ORDER BY revision LIMIT 61',[scope.tenant,id]);
    if (history.rows.length !== row.revision || history.rows.some((item,i)=>item.revision!==i+1)) fail('SERVICE_UNAVAILABLE');
    const events = history.rows.map(item=>item.event);
    try {
      if(!isDeepStrictEqual(setup(row.setup),row.setup))fail('SERVICE_UNAVAILABLE');
      const checked=[];
      for(const event of events){
        const keys={realization:['step','occurred_on','evidence_reference','deliverable_reference','version'],
          delivery:['step','occurred_on','evidence_reference','recipient','channel'],
          acceptance:['step','occurred_on','evidence_reference','recipient','outcome','reservations']}[event?.step];
        if(!keys)fail('SERVICE_UNAVAILABLE');
        const raw=Object.fromEntries(keys.filter(key=>Object.hasOwn(event,key)).map(key=>[key,event[key]]));
        const normalized=advance(checked,raw,now?.());
        if(!isDeepStrictEqual(normalized,event))fail('SERVICE_UNAVAILABLE');
        checked.push(normalized);
      }
    } catch {fail('SERVICE_UNAVAILABLE');}
    return { id:row.id, ...row.setup, revision:row.revision, events,
      audit:history.rows.map(item=>({ revision:item.revision,actor:item.actor,recorded_at:item.recorded_at })),
      references_verified:false, acceptance_kind:'reported_not_signed' };
  }
  async function sources(user, track) {
    if (typeof validateSources !== 'function' || await validateSources(user,track) !== true) fail('SERVICE_SOURCE_UNAVAILABLE');
  }
  return {
    access: user => transaction(user,async(client,scope)=> {
      const result=await client.query('SELECT track,can_read,can_prepare,can_deliver,can_accept FROM production_private.access_decisions WHERE tenant=$1 AND actor=$2 AND active AND can_read ORDER BY track',[scope.tenant,scope.actor]);
      if (!result.rows.length) fail('SERVICE_FORBIDDEN');
      return result.rows;
    }),
    list: (user,track) => transaction(user,async(client,scope)=> {
      await access(client,scope,track,'read');
      const result=await client.query('SELECT id,setup,revision,created_at FROM production_private.cycles WHERE tenant=$1 AND track=$2 ORDER BY created_at DESC,id LIMIT 101',[scope.tenant,track]);
      if(result.rows.length>100)fail('SERVICE_LIMIT');
      return result.rows.map(row=>({id:row.id,...row.setup,revision:row.revision,created_at:row.created_at}));
    }),
    get: (user,id) => transaction(user,async(client,scope)=>load(client,scope,uuid(id))),
    create: async(user,input,requestId)=> {
      const value=setup(input); const request=uuid(requestId); const hash=digest(value);
      await sources(user,value.track);
      return transaction(user,async(client,scope)=> {
        await access(client,scope,value.track,'prepare');
        const id=randomUUID();
        const inserted=await client.query(`INSERT INTO production_private.cycles(tenant,id,track,setup,created_by,request_id,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant,created_by,request_id) DO NOTHING RETURNING id`,[scope.tenant,id,value.track,value,scope.actor,request,hash]);
        if(inserted.rows.length)return {item:await load(client,scope,id),replayed:false};
        const previous=await client.query('SELECT id,request_hash FROM production_private.cycles WHERE tenant=$1 AND created_by=$2 AND request_id=$3',[scope.tenant,scope.actor,request]);
        if(previous.rows.length!==1||previous.rows[0].request_hash!==hash)fail('SERVICE_CONFLICT');
        return {item:await load(client,scope,previous.rows[0].id),replayed:true};
      });
    },
    append: async(user,id,input,revision,requestId)=> {
      id=uuid(id); const request=uuid(requestId);
      if(!Number.isInteger(revision)||revision<0||revision>=60)fail('SERVICE_INVALID');
      // Resolve governed dossier metadata before taking short SQL row locks.
      const track=await transaction(user,async(client,scope)=>(await load(client,scope,id)).track);
      await sources(user,track);
      return transaction(user,async(client,scope)=> {
        const current=await load(client,scope,id,true);
        const permission={realization:'prepare',delivery:'deliver',acceptance:'accept'}[input?.step];
        if(!permission)fail('SERVICE_INVALID');
        await access(client,scope,current.track,permission);
        const hash=digest({id,input,revision});
        const previous=await client.query('SELECT cycle_id,request_hash FROM production_private.events WHERE tenant=$1 AND actor=$2 AND request_id=$3',[scope.tenant,scope.actor,request]);
        if(previous.rows.length){if(previous.rows.length!==1||previous.rows[0].cycle_id!==id||previous.rows[0].request_hash!==hash)fail('SERVICE_CONFLICT');return {item:current,replayed:true};}
        if(current.revision!==revision)fail('SERVICE_CONFLICT');
        const event=advance(current.events,input,now?.());
        const next=revision+1;
        await client.query('INSERT INTO production_private.events(tenant,cycle_id,revision,step,event,actor,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[scope.tenant,id,next,event.step,event,scope.actor,request,hash]);
        const updated=await client.query('UPDATE production_private.cycles SET revision=$3 WHERE tenant=$1 AND id=$2 AND revision=$4 RETURNING id',[scope.tenant,id,next,revision]);
        if(updated.rows.length!==1)fail('SERVICE_CONFLICT');
        return {item:await load(client,scope,id),replayed:false};
      });
    }
  };
}
module.exports={createProductionServiceStore,uuid};

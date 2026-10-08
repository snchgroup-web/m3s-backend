'use strict';
const {identifier}=require('./rh-dossiers-contract.cjs');
const {assertReturnWriterAccess}=require('./rh-return-production-access.cjs');
function createReturnContextReader(pool,sources) {
  return async (scope,inputs) => {
    if (!Array.isArray(inputs)||inputs.length!==1) throw Error('RH_RETURN_INVALID_BATCH');
    const target=inputs[0];
    if (!target||Object.keys(target).sort().join(',')!=='dossierRevision,employeeId,kind,period'||
      !['salary','hours'].includes(target.kind)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(target.period)||
      !Number.isSafeInteger(target.dossierRevision)||target.dossierRevision<1) throw Error('RH_RETURN_INVALID_TARGET');
    identifier(target.employeeId);
    const client=await pool.connect(); let broken=false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='10s'");
      await assertReturnWriterAccess(client);
      await client.query("SELECT set_config('m3s.tenant',$1,true),set_config('m3s.owner',$2,true),set_config('m3s.actor',$3,true)",[scope.tenant,scope.owner,scope.actor]);
      const context={client,scope,target};
      if (await sources.authorizeObservation(context)!==true) throw Error('RH_RETURN_OBSERVATION_DENIED');
      const dossier=(await client.query('SELECT revision,display_name,classification,record_status FROM rh_private.employee_revisions WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 ORDER BY revision DESC LIMIT 1',[scope.tenant,scope.owner,target.employeeId])).rows[0];
      if (!dossier||dossier.revision!==target.dossierRevision||dossier.classification!=='C3'||dossier.record_status!=='draft') throw Error('RH_RETURN_STALE_DOSSIER');
      const expectation=await sources.resolveExpectation(context);
      if (expectation.employeeName!==dossier.display_name) throw Error('RH_RETURN_EXPECTATION_UNAVAILABLE');
      const previous=(await client.query('SELECT observation_revision FROM rh_private.return_observations WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 AND worked_period=$4 AND kind=$5 ORDER BY observation_revision DESC LIMIT 1',[scope.tenant,scope.owner,target.employeeId,`${target.period}-01`,target.kind])).rows[0];
      await client.query('COMMIT');
      return {target:{...target},expectation,expectedPreviousRevision:previous?.observation_revision??0,paymentConfirmed:false};
    } catch(error) { await client.query('ROLLBACK').catch(()=>{broken=true;}); throw error; }
    finally {client.release(broken);}
  };
}
module.exports={createReturnContextReader};

'use strict';
const {returnDatabaseOptions,assertReturnConnectorAccess} = require('./rh-return-production-access.cjs');
const {createQualifiedReturnObservationService} = require('./rh-return-observation-service.cjs');
const {createQualifiedReturnSqlSources} = require('./rh-return-sql-sources.cjs');
const {createQualifiedReturnRuntime} = require('./rh-return-runtime.cjs');

// Host wiring only: no DDL, source decisions, credential creation or deployment.
function createQualifiedReturnHost({env={},identityRuntime,readBindings,origins,
  createPool,createRuntime=createQualifiedReturnRuntime,warn=() => {}} = {}) {
  const closed = () => ({router:createRuntime(),close:async () => {}});
  if (env.M3S_RH_RETURN_PROFILE !== 'rh-return-observation-v1' ||
      identityRuntime?.mode !== 'google' || typeof identityRuntime.authenticate !== 'function' ||
      typeof readBindings !== 'function' || typeof createPool !== 'function') return closed();
  let pool;
  try {
    pool = createPool(returnDatabaseOptions(env));
    if (!['connect','end','on'].every(key => typeof pool?.[key] === 'function')) throw Error('invalid pool');
    pool.on('error',() => warn('RH_RETURN_POOL_UNAVAILABLE'));
    const checkout = {async connect() {
      const client = await pool.connect();
      try {
        await assertReturnConnectorAccess(client);
        await client.query('SET ROLE m3s_rh_return_writer');
        return client;
      } catch {
        client.release(true);
        throw Error('RH_RETURN_CONNECTOR_UNAVAILABLE');
      }
    }};
    const sources = createQualifiedReturnSqlSources({qualified:true});
    const service = createQualifiedReturnObservationService(checkout,{qualified:true,...sources});
    const router = createRuntime({qualified:true,identityRuntime,readBindings,
      observeBatch:(scope,inputs) => service.observeBatch(scope,inputs),origins});
    let closing;
    return {router,close:() => closing ??= Promise.resolve().then(() => pool.end())};
  } catch {
    if (typeof pool?.end === 'function') Promise.resolve().then(() => pool.end()).catch(() => {});
    warn('RH_RETURN_CONFIGURATION_UNAVAILABLE');
    return closed();
  }
}
module.exports = {createQualifiedReturnHost};

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {returnDatabaseOptions,assertReturnConnectorAccess,assertReturnWriterAccess} = require('./rh-return-production-access.cjs');
test('production connector requires a distinct password and verified TLS', () => {
  assert.throws(() => returnDatabaseOptions(), /CONNECTOR_UNAVAILABLE/);
  const env = {M3S_RH_RETURN_DB_PASSWORD:'x'.repeat(32),M3S_RH_DB_CA_PEM:'-----BEGIN CERTIFICATE-----\nSYNTHETIC'};
  const options = returnDatabaseOptions(env);
  assert.equal(options.ssl.rejectUnauthorized,true);
  assert.equal(options.user,'m3s_rh_return_connector'); assert.equal(options.max,2);
  for (const key of ['M3S_RH_DB_PASSWORD','M3S_RH_DOCUMENT_DB_PASSWORD','M3S_GED_DB_PASSWORD']) {
    assert.throws(() => returnDatabaseOptions({...env,[key]:env.M3S_RH_RETURN_DB_PASSWORD}), /CONNECTOR_UNAVAILABLE/);
  }
});
test('connector refuses extra memberships, direct access and elevated role flags', async () => {
  const base = {role:'m3s_rh_return_connector',rolcanlogin:true,rolinherit:false,rolsuper:false,
    rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolconnlimit:2,
    memberships:1,can_assume_writer:true,direct_access:false};
  const client = row => ({query: async sql => sql === 'RESET ROLE' ? {rows:[]} : {rows:[row]}});
  await assertReturnConnectorAccess(client(base));
  for (const [key,value] of Object.entries({memberships:2,direct_access:true,rolcanlogin:false,
    rolinherit:true,rolsuper:true,rolcreatedb:true,rolcreaterole:true,rolreplication:true,rolbypassrls:true,can_assume_writer:false})) {
    await assert.rejects(assertReturnConnectorAccess(client({...base,[key]:value})), /CONNECTOR_UNAVAILABLE/);
  }
  await assertReturnConnectorAccess(client({...base,rolcanlogin:false}), {loginRequired:false});
});
test('writer fails closed for missing or privileged role', async () => {
  await assert.rejects(assertReturnWriterAccess({query:async () => ({rows:[]})}), /CONNECTOR_UNAVAILABLE/);
  await assert.rejects(assertReturnWriterAccess({query:async () => ({rows:[{role:'postgres'}]})}), /CONNECTOR_UNAVAILABLE/);
});

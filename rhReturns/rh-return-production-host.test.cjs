'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createQualifiedReturnHost} = require('./rh-return-production-host.cjs');
test('host is closed without explicit profile, identity, source and valid credentials', () => {
  let pools=0; const configs=[];
  const createRuntime = options => {configs.push(options); return () => {};};
  createQualifiedReturnHost({createRuntime,createPool:() => {pools++;}});
  createQualifiedReturnHost({env:{M3S_RH_RETURN_PROFILE:'rh-return-observation-v1'},
    identityRuntime:{mode:'google',authenticate(){}},readBindings:async () => [],createRuntime,
    createPool:() => {pools++;}});
  assert.equal(pools,0); assert.ok(configs.every(value => !value?.qualified));
});
test('host uses its own pool and closes it once, without DDL or implicit credentials', async () => {
  let ends=0; let options; let runtimeOptions;
  const host = createQualifiedReturnHost({env:{M3S_RH_RETURN_PROFILE:'rh-return-observation-v1',
    M3S_RH_RETURN_DB_PASSWORD:'x'.repeat(32),M3S_RH_DB_CA_PEM:'-----BEGIN CERTIFICATE-----SYNTHETIC'},
    identityRuntime:{mode:'google',authenticate(){}},readBindings:async () => [],
    createPool:value => {options=value; return {connect:async () => {throw Error('unused');},end:async () => {ends++;},on(){}};},
    createRuntime:value => {runtimeOptions=value; return () => {};}});
  assert.equal(options.user,'m3s_rh_return_connector');
  assert.equal(options.ssl.rejectUnauthorized,true);
  assert.equal(runtimeOptions.qualified,true);
  await assert.rejects(runtimeOptions.observeBatch({tenant:'a'.repeat(64),owner:'b'.repeat(64),actor:'c'.repeat(64)},[]), /INVALID_BATCH/);
  await Promise.all([host.close(),host.close()]); assert.equal(ends,1);
});
test('an unqualified connector is destroyed before a transaction or write', async () => {
  const queries=[]; const releases=[]; let runtime;
  const host = createQualifiedReturnHost({env:{M3S_RH_RETURN_PROFILE:'rh-return-observation-v1',
    M3S_RH_RETURN_DB_PASSWORD:'x'.repeat(32),M3S_RH_DB_CA_PEM:'-----BEGIN CERTIFICATE-----SYNTHETIC'},
    identityRuntime:{mode:'google',authenticate(){}},readBindings:async () => [],
    createRuntime:value => {runtime=value; return () => {};},
    createPool:() => ({on(){},end:async () => {},connect:async () => ({
      query:async sql => {queries.push(sql); return {rows:sql === 'RESET ROLE' ? [] : [{role:'postgres'}]};},
      release:broken => releases.push(broken)
    })})});
  await assert.rejects(runtime.observeBatch({tenant:'a'.repeat(64),owner:'b'.repeat(64),actor:'c'.repeat(64)},[{
    requestId:'22222222-2222-4222-8222-222222222222',employeeId:'11111111-1111-4111-8111-111111111111',
    dossierRevision:2,kind:'salary',period:'2026-09',expectedPreviousRevision:0,source:'{}'
  }]), /CONNECTOR_UNAVAILABLE/);
  assert.deepEqual(releases,[true]);
  assert.ok(queries.every(sql => !/^BEGIN|^INSERT|^SET ROLE/.test(sql)));
  await host.close();
});

'use strict';
const { productionDatabaseOptions, assertProductionConnector } = require('../productionServiceRuntime');

const plan = () => ({ mode: 'plan', connectionAttempted: false, checks: [
  'distinct-environment-secret', 'verified-tls', 'dedicated-role-and-grants',
  'read-only-transaction', 'schema-version'
], activatesProfile: false, writesBusinessRecords: false });

async function checkProductionConnection({ env = process.env,
  createPool = options => new (require('pg').Pool)(options),
  assertConnector = assertProductionConnector } = {}) {
  let pool, client, transaction = false, broken = false, poolFault = false;
  let stage = 'CONFIGURATION';
  let result;
  try {
    const options = { ...productionDatabaseOptions(env), max: 1 };
    stage = 'CONNECTION';
    pool = createPool(options);
    pool.on('error', () => { poolFault = true; });
    client = await pool.connect();
    stage = 'READ_ONLY';
    await client.query('BEGIN READ ONLY');
    transaction = true;
    const readonly = await client.query('SHOW transaction_read_only');
    if (readonly.rows[0]?.transaction_read_only !== 'on') throw new Error();
    stage = 'TLS';
    const tls = await client.query('SELECT ssl,version,bits FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    if (tls.rows.length !== 1 || tls.rows[0].ssl !== true ||
      !['TLSv1.2', 'TLSv1.3'].includes(tls.rows[0].version) || tls.rows[0].bits < 128 ||
      !Number.isInteger(tls.rows[0].bits)) throw new Error();
    stage = 'PRIVILEGES';
    await assertConnector(client);
    stage = 'SCHEMA';
    const versions = await client.query('SELECT version FROM production_private.schema_versions');
    if (versions.rows.length !== 1 || versions.rows[0].version !== 1) throw new Error();
    result = { mode: 'read_only', status: 'passed', scope: 'database_only',
      verifiedTls: true, dedicatedRole: true, schemaVersion: 1, poolLimit: 1,
      profileEnabled: env.M3S_PRODUCTION_SERVICE_PROFILE === 'service-cycle-v1',
      activatesProfile: false, writesBusinessRecords: false,
      operationalSmokeTested: false };
  } catch {
    result = { mode: 'read_only', status: 'failed', code: `SERVICE_CHECK_${stage}` };
  } finally {
    if (transaction) {
      try { await client.query('ROLLBACK'); }
      catch { broken = true; result = { mode: 'read_only', status: 'failed', code: 'SERVICE_CHECK_CLEANUP' }; }
    }
    try { if (client) client.release(broken); }
    catch { result = { mode: 'read_only', status: 'failed', code: 'SERVICE_CHECK_CLEANUP' }; }
    try { if (pool) await pool.end(); }
    catch { result = { mode: 'read_only', status: 'failed', code: 'SERVICE_CHECK_CLEANUP' }; }
  }
  return poolFault ? { mode: 'read_only', status: 'failed', code: 'SERVICE_CHECK_CONNECTION' } : result;
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--plan')) return plan();
  if (args.length !== 1 || args[0] !== '--check-read-only') {
    return { mode: 'plan', status: 'failed', code: 'SERVICE_CHECK_ARGUMENTS', connectionAttempted: false };
  }
  return checkProductionConnection();
}
if (require.main === module) main().then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}).catch(() => {
  process.stdout.write('{"status":"failed","code":"SERVICE_CHECK_UNAVAILABLE"}\n');
  process.exitCode = 1;
});
module.exports = { plan, checkProductionConnection, main };

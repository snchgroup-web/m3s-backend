'use strict';
const fail = () => { throw Error('RH_RETURN_CONNECTOR_UNAVAILABLE'); };
const reads = Object.freeze(['schema_versions','employee_revisions','entitlement_revisions',
  'return_observations','return_decision_revisions','return_expectation_revisions']);
function returnDatabaseOptions(env = {}) {
  const password = env.M3S_RH_RETURN_DB_PASSWORD;
  const ca = env.M3S_RH_DB_CA_PEM;
  if (typeof password !== 'string' || password.length < 32 ||
      [env.M3S_RH_DB_PASSWORD,env.M3S_RH_DOCUMENT_DB_PASSWORD,env.M3S_GED_DB_PASSWORD].includes(password) ||
      typeof ca !== 'string' || !ca.includes('-----BEGIN CERTIFICATE-----')) fail();
  return { host:'postgres.railway.internal',port:5432,database:'railway',
    user:'m3s_rh_return_connector',password,ssl:{ca,rejectUnauthorized:true},max:2,
    connectionTimeoutMillis:8000,idleTimeoutMillis:10000,statement_timeout:10000,
    query_timeout:12000,idle_in_transaction_session_timeout:15000,application_name:'m3s-rh-returns' };
}
async function assertReturnConnectorAccess(client, { loginRequired = true } = {}) {
  await client.query('RESET ROLE');
  const result = await client.query(`SELECT session_user AS role,rolcanlogin,rolinherit,rolsuper,
    rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
    EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles w ON w.oid=m.roleid
      WHERE m.member=r.oid AND w.rolname='m3s_rh_return_writer'
        AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option) AS can_assume_writer,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r','v','m','p','f') AND (c.relowner=r.oid OR
        has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) AS direct_access
    FROM pg_roles r WHERE rolname=session_user`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row.role !== 'm3s_rh_return_connector' ||
      row.rolcanlogin !== loginRequired || row.rolconnlimit !== 2 || row.memberships !== 1 ||
      row.can_assume_writer !== true || row.direct_access !== false ||
      ['rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(key => row[key] !== false)) fail();
}
async function assertReturnWriterAccess(client) {
  const role = await client.query(`SELECT current_user AS role,rolcanlogin,rolinherit,rolsuper,
    rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships
    FROM pg_roles r WHERE rolname=current_user`);
  const row = role.rows[0];
  if (role.rows.length !== 1 || row.role !== 'm3s_rh_return_writer' || row.memberships !== 0 ||
      ['rolcanlogin','rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(key => row[key] !== false)) fail();
  const tables = await client.query(`SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
    c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table,
    has_schema_privilege(current_user,n.oid,'USAGE') AS can_use,
    has_schema_privilege(current_user,n.oid,'CREATE') AS can_create,
    has_table_privilege(current_user,c.oid,'SELECT') AS can_read,
    has_table_privilege(current_user,c.oid,'INSERT') AS can_add,
    has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_change
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rh_private' AND c.relname=ANY($1::text[])`,[reads]);
  if (tables.rows.length !== reads.length || !reads.every(name => tables.rows.some(row => row.relname === name)) ||
      tables.rows.some(row => row.relkind !== 'r' || row.relrowsecurity !== true || row.relforcerowsecurity !== true ||
        row.owns_table !== false || row.can_create !== false || row.can_use !== true || row.can_read !== true ||
        row.can_change !== false || row.can_add !== (row.relname === 'return_observations'))) fail();
  const external = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','v','m','p','f') AND NOT (n.nspname='rh_private' AND c.relname=ANY($1::text[]))
      AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR
        has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) AS exposed`,[reads]);
  if (external.rows.length !== 1 || external.rows[0].exposed !== false) fail();
}
module.exports = { returnDatabaseOptions,assertReturnConnectorAccess,assertReturnWriterAccess };

'use strict';

const { createHash } = require('node:crypto');
const HASH = /^[a-f0-9]{64}$/;
const fail = () => { throw new Error('RH_SERVICE_UNAVAILABLE'); };
const identifier = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && !/[\s\x00-\x1f]/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const tables = Object.freeze(['schema_versions', 'employees', 'creation_requests',
  'employee_revisions', 'entitlement_revisions']);

function databaseOptions(env) {
  if (typeof env?.M3S_RH_DB_PASSWORD !== 'string' || env.M3S_RH_DB_PASSWORD.length < 32 ||
      typeof env.M3S_RH_DB_CA_PEM !== 'string' || !env.M3S_RH_DB_CA_PEM.includes('-----BEGIN CERTIFICATE-----')) fail();
  return { host: 'postgres.railway.internal', port: 5432, database: 'railway', user: 'm3s_rh_reader',
    password: env.M3S_RH_DB_PASSWORD, ssl: { ca: env.M3S_RH_DB_CA_PEM, rejectUnauthorized: true },
    max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000,
    statement_timeout: 10000, query_timeout: 12000, idle_in_transaction_session_timeout: 15000,
    application_name: 'm3s-rh-read' };
}

async function assertDatabaseAccess(client) {
  const roles = await client.query(`SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole,
    rolreplication, rolbypassrls, rolinherit,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships
    FROM pg_roles r WHERE rolname=current_user`);
  const role = roles.rows[0];
  if (roles.rows.length !== 1 || role.role !== 'm3s_rh_reader' || role.memberships !== 0 ||
      ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'rolinherit']
        .some(key => role[key] !== false)) fail();
  const rights = await client.query(`SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table,
    has_table_privilege(current_user,c.oid,'SELECT') AS can_read,
    has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_mutate,
    has_schema_privilege(current_user,n.oid,'CREATE') AS can_create,
    has_schema_privilege(current_user,n.oid,'USAGE') AS can_use
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rh_private' AND c.relname=ANY($1::text[])`, [tables]);
  if (rights.rows.length !== tables.length || !tables.every(name => rights.rows.some(row => row.relname === name)) ||
      rights.rows.some(row => row.relkind !== 'r' || row.relrowsecurity !== true ||
        row.relforcerowsecurity !== true || row.owns_table !== false || row.can_create !== false ||
        row.can_use !== true || row.can_mutate !== false || row.can_read !== (row.relname !== 'creation_requests'))) fail();
  const external = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','rh_private')
      AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','v','m','p','f')
      AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) AS can_access_external`);
  if (external.rows.length !== 1 || external.rows[0].can_access_external !== false) fail();
  const versions = await client.query('SELECT version FROM rh_private.schema_versions');
  if (versions.rows.length !== 1 || versions.rows[0].version !== 'rh-read-v1') fail();
}

// Injected only after operator qualification; no env switch, DDL or implicit GED role reuse.
function createRhPostgresSource({ pool, qualified = false } = {}) {
  if (qualified !== true || typeof pool?.connect !== 'function') fail();
  async function transaction(scope, work) {
    if (!scope || !HASH.test(scope.tenant) || !HASH.test(scope.owner)) fail();
    let client, broken = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('m3s.tenant',$1,true),set_config('m3s.owner',$2,true)",
        [scope.tenant, scope.owner]);
      await assertDatabaseAccess(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch { broken = true; } }
      if (error?.message === 'RH_ACCESS_DENIED') throw error;
      fail();
    } finally { client?.release(broken); }
  }
  const currentEntitlement = async (client, scope) => {
    const result = await client.query(`SELECT revision,can_read FROM rh_private.entitlement_revisions
      WHERE tenant=$1 AND owner_id=$2 ORDER BY revision DESC LIMIT 1`, [scope.tenant, scope.owner]);
    const row = result.rows[0];
    if (result.rows.length > 1 || (row && (!Number.isInteger(row.revision) || row.revision < 1 ||
        row.revision > 10000 || typeof row.can_read !== 'boolean'))) fail();
    return row?.can_read === true ? row : null;
  };
  const register = Object.freeze({
    async access(scope) {
      return transaction(scope, async client => {
        const decision = await currentEntitlement(client, scope);
        if (!decision) throw new Error('RH_ACCESS_DENIED');
        return { revision: String(decision.revision) };
      });
    },
    async list(scope, { limit = 50, offset = 0 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
        throw new Error('RH_INVALID_PAGE');
      }
      return transaction(scope, async client => {
        // Check again in the data transaction: a revocation between policy and list stays closed.
        if (!await currentEntitlement(client, scope)) throw new Error('RH_ACCESS_DENIED');
        const result = await client.query(`SELECT employee_id,revision,display_name,position_ref,site_ref,
          employment_start_date::text,record_status,classification FROM (
          SELECT DISTINCT ON (employee_id) employee_id,revision,display_name,position_ref,site_ref,
            employment_start_date,record_status,classification FROM rh_private.employee_revisions
          WHERE tenant=$1 AND owner_id=$2 ORDER BY employee_id,revision DESC
        ) latest ORDER BY employee_id LIMIT $3 OFFSET $4`, [scope.tenant, scope.owner, limit, offset]);
        return result.rows;
      });
    }
  });
  return Object.freeze({
    async readBindings({ userId, organizationId } = {}) {
      if (!identifier(userId) || !identifier(organizationId)) fail();
      const scope = { tenant: digest(organizationId), owner: digest(userId) };
      return transaction(scope, async client => await currentEntitlement(client, scope)
        ? [{ userId, organizationId, permissions: ['read'] }] : []);
    },
    getRegister: async () => register
  });
}

module.exports = { databaseOptions, assertDatabaseAccess, createRhPostgresSource };

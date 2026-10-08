'use strict';

const tables = Object.freeze(['schema_versions', 'employee_revisions', 'entitlement_revisions',
  'mutation_entitlement_revisions', 'document_attachment_decision_revisions',
  'contract_document_metadata_revisions', 'contract_documents', 'contract_document_links']);
const writable = new Set(['contract_documents', 'contract_document_links']);
const fail = () => { throw new Error('RH_DOCUMENT_SOURCE_UNAVAILABLE'); };

async function assertRhDocumentAttachmentAccess(client) {
  const roles = await client.query(`SELECT current_user AS role,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
    rolreplication,rolbypassrls,rolinherit,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships
    FROM pg_roles r WHERE rolname=current_user`);
  const role = roles.rows[0];
  if (roles.rows.length !== 1 || role.role !== 'm3s_rh_document_writer' || role.memberships !== 0 ||
      ['rolcanlogin', 'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'rolinherit']
        .some(key => role[key] !== false)) fail();
  const rights = await client.query(`SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
    c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table,
    has_schema_privilege(current_user,n.oid,'USAGE') AS can_use,
    has_schema_privilege(current_user,n.oid,'CREATE') AS can_create,
    has_table_privilege(current_user,c.oid,'SELECT') AS can_read,
    has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
    has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_change
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rh_private' AND c.relname=ANY($1::text[])`, [tables]);
  if (rights.rows.length !== tables.length || !tables.every(name => rights.rows.some(row => row.relname === name)) ||
      rights.rows.some(row => row.relkind !== 'r' || row.relrowsecurity !== true || row.relforcerowsecurity !== true ||
        row.owns_table !== false || row.can_use !== true || row.can_create !== false || row.can_read !== true ||
        row.can_insert !== writable.has(row.relname) || row.can_change !== false)) fail();
  const other = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','v','m','p','f')
      AND NOT (n.nspname='rh_private' AND c.relname=ANY($1::text[]))
      AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) AS allowed`, [tables]);
  if (other.rows.length !== 1 || other.rows[0].allowed !== false) fail();
  const versions = await client.query('SELECT version FROM rh_private.schema_versions');
  if (versions.rows.length !== 1 || versions.rows[0].version !== 'rh-read-v1') fail();
}

// Check every borrowed connection; never create a role, grant or connection setting.
function guardedAttachmentPool(pool) {
  return { async connect() {
    const client = await pool.connect();
    let broken = false;
    try {
      if (typeof client?.query !== 'function' || typeof client?.release !== 'function') fail();
      await client.query('BEGIN READ ONLY');
      await assertRhDocumentAttachmentAccess(client);
      await client.query('COMMIT');
      return client;
    } catch {
      if (typeof client?.query === 'function') {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
      }
      if (typeof client?.release === 'function') client.release(broken);
      fail();
    }
  } };
}

module.exports = { assertRhDocumentAttachmentAccess, guardedAttachmentPool };

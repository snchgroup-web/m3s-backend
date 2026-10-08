'use strict';

const { createHash } = require('node:crypto');
const { validateScopedDocumentTarget, validateDocumentCandidate } = require('./rhDocumentLink.js');
const fail = code => { throw new Error(code); };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f]/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;

function documentAuthorityLockKey(scope) {
  if (!scope || Object.keys(scope).sort().join(',') !== 'owner,tenant' ||
      ![scope.tenant, scope.owner].every(value => typeof value === 'string' && HASH.test(value))) {
    fail('RH_DOCUMENT_INVALID_SCOPE');
  }
  return `rh-document-authority-v1:${scope.tenant}:${scope.owner}`;
}

// Local candidate, no connection configuration, DDL, grant, content read or write.
function createRhDocumentPostgresSource({ qualified = false, originalQualified = false, pool } = {}) {
  if (qualified !== true || typeof pool?.connect !== 'function') fail('RH_DOCUMENT_NOT_ENABLED');
  async function currentBoolean(client, scope, kind) {
    const query = kind === 'read'
      ? `SELECT revision,can_read AS allowed FROM rh_private.entitlement_revisions
          WHERE tenant=$1 AND owner_id=$2 ORDER BY revision DESC LIMIT 1`
      : `SELECT revision,can_revise AS allowed FROM rh_private.mutation_entitlement_revisions
          WHERE tenant=$1 AND owner_id=$2 ORDER BY revision DESC LIMIT 1`;
    const result = await client.query(query, [scope.tenant, scope.owner]);
    const row = result.rows[0];
    if (result.rows.length > 1 || (row && (!Number.isInteger(row.revision) || row.revision < 1 ||
        row.revision > 10000 || typeof row.allowed !== 'boolean'))) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
    return row?.allowed === true;
  }
  async function rhAllowed(client, scope) {
    return await currentBoolean(client, scope, 'read') && await currentBoolean(client, scope, 'revise');
  }
  async function transaction(scope, suppliedClient, work) {
    const authorityKey = documentAuthorityLockKey(scope);
    let client, broken = false;
    const own = suppliedClient === undefined;
    try {
      client = own ? await pool.connect() : suppliedClient;
      if (typeof client?.query !== 'function' || (own && typeof client.release !== 'function')) {
        fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
      }
      if (own) {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
        await client.query("SELECT set_config('m3s.tenant',$1,true),set_config('m3s.owner',$2,true)",
          [scope.tenant, scope.owner]);
        await client.query("SET LOCAL lock_timeout='5s'");
      }
      const context = await client.query(`SELECT current_setting('m3s.tenant',true) AS tenant,
        current_setting('m3s.owner',true) AS owner,current_setting('transaction_isolation') AS isolation`);
      const row = context.rows[0];
      if (context.rows.length !== 1 || row.tenant !== scope.tenant || row.owner !== scope.owner ||
          row.isolation !== 'read committed') fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
      // Held until the host commits/rolls back; revokers must use the same key exclusively.
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [authorityKey]);
      const result = await work(client);
      if (own) await client.query('COMMIT');
      return result;
    } catch (error) {
      if (own && client) { try { await client.query('ROLLBACK'); } catch { broken = true; } }
      if (['RH_DOCUMENT_ATTACHMENT_DENIED', 'RH_DOCUMENT_SCOPE_MISMATCH', 'RH_DOCUMENT_NOT_ELIGIBLE']
        .includes(error?.message)) throw error;
      fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
    } finally { if (own && typeof client?.release === 'function') client.release(broken); }
  }
  async function documentAllowed(client, target) {
    if (!await rhAllowed(client, target.scope)) return false;
    const result = await client.query(`SELECT revision,can_attach FROM rh_private.document_attachment_decision_revisions
      WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 AND dossier_revision=$4
        AND document_id=$5 AND version_id=$6 AND purpose=$7 ORDER BY revision DESC LIMIT 1`,
    [target.scope.tenant, target.scope.owner, target.employeeId, target.dossierRevision,
      target.documentId, target.versionId, target.purpose]);
    const row = result.rows[0];
    if (result.rows.length > 1 || (row && (!Number.isInteger(row.revision) || row.revision < 1 ||
        row.revision > 10000 || typeof row.can_attach !== 'boolean'))) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
    return row?.can_attach === true;
  }
  const originalGate = () => { if (originalQualified !== true) fail('RH_DOCUMENT_NOT_ENABLED'); };
  async function originalAllowed(client, target) {
    if (!await currentBoolean(client, target.scope, 'read')) return false;
    const result = await client.query(`SELECT revision,can_verify_original AS allowed
      FROM rh_private.document_original_decision_revisions
      WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 AND dossier_revision=$4
        AND document_id=$5 AND version_id=$6 AND purpose=$7 ORDER BY revision DESC LIMIT 1`,
    [target.scope.tenant, target.scope.owner, target.employeeId, target.dossierRevision,
      target.documentId, target.versionId, target.purpose]);
    const row = result.rows[0];
    if (result.rows.length > 1 || (row && (!Number.isInteger(row.revision) || row.revision < 1 ||
        row.revision > 10000 || typeof row.allowed !== 'boolean'))) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
    return row?.allowed === true;
  }
  async function metadataRow(connection, target) {
    // Latest declaration for the version, never an older eligible employee/status.
    const result = await connection.query(`SELECT tenant,owner_id,document_id,version_id,metadata_revision,
      employee_id,dossier_revision,purpose,category,classification,record_status,trashed
      FROM rh_private.contract_document_metadata_revisions
      WHERE tenant=$1 AND owner_id=$2 AND document_id=$3 AND version_id=$4
      ORDER BY metadata_revision DESC LIMIT 1`,
    [target.scope.tenant, target.scope.owner, target.documentId, target.versionId]);
    if (result.rows.length > 1) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
    const row = result.rows[0];
    if (!row) return null;
    if (!Number.isInteger(row.metadata_revision) || row.metadata_revision < 1 || row.metadata_revision > 10000) {
      fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
    }
    const document = Object.freeze({ tenant: row.tenant, owner: row.owner_id,
      employeeId: row.employee_id, dossierRevision: row.dossier_revision, documentId: row.document_id,
      versionId: row.version_id, purpose: row.purpose, category: row.category,
      classification: row.classification, status: row.record_status, trashed: row.trashed });
    validateDocumentCandidate(document, target);
    return { document, revision: row.metadata_revision };
  }
  return Object.freeze({
    async readBindings({ userId, organizationId } = {}) {
      if (!identifier(userId) || !identifier(organizationId)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
      const identity = Object.freeze({ userId, organizationId });
      const scope = Object.freeze({ tenant: digest(organizationId), owner: digest(userId) });
      return transaction(scope, undefined, async client => {
        if (!await currentBoolean(client, scope, 'read')) return [];
        const permissions = await currentBoolean(client, scope, 'revise') ? ['read', 'revise'] : ['read'];
        return [{ ...identity, permissions }];
      });
    },
    async readDocumentBindings(input, { client } = {}) {
      const target = validateScopedDocumentTarget(input);
      return transaction(target.scope, client, async connection => {
        if (!await documentAllowed(connection, target)) return [];
        const { scope, ...reference } = target;
        return [{ ...scope, ...reference, permissions: ['attach'] }];
      });
    },
    async readMetadata(input, { client } = {}) {
      const target = validateScopedDocumentTarget(input);
      return transaction(target.scope, client, async connection => {
        if (!await documentAllowed(connection, target)) fail('RH_DOCUMENT_ATTACHMENT_DENIED');
        return (await metadataRow(connection, target))?.document ?? null;
      });
    },
    async readOriginalRhBindings({ userId, organizationId } = {}) {
      originalGate();
      if (!identifier(userId) || !identifier(organizationId)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
      const identity = Object.freeze({ userId, organizationId });
      const scope = Object.freeze({ tenant: digest(organizationId), owner: digest(userId) });
      return transaction(scope, undefined, async client => await currentBoolean(client, scope, 'read')
        ? [{ ...identity, permissions: ['read'] }] : []);
    },
    async readOriginalBindings(input, { client } = {}) {
      originalGate(); const target = validateScopedDocumentTarget(input);
      return transaction(target.scope, client, async connection => {
        if (!await originalAllowed(connection, target)) return [];
        const { scope, ...reference } = target;
        return [{ ...scope, ...reference, permissions: ['verify_original'] }];
      });
    },
    async readOriginalDossier(input, { client } = {}) {
      originalGate(); const target = validateScopedDocumentTarget(input);
      return transaction(target.scope, client, async connection => {
        if (!await originalAllowed(connection, target)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        const result = await connection.query(`SELECT revision,record_status,classification
          FROM rh_private.employee_revisions WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3
          ORDER BY revision DESC LIMIT 1`, [target.scope.tenant, target.scope.owner, target.employeeId]);
        if (result.rows.length > 1) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        const row = result.rows[0];
        if (!row) return null;
        return Object.freeze({ ...target.scope, employeeId: target.employeeId,
          revision: row.revision, status: row.record_status, classification: row.classification });
      });
    },
    async readOriginalMetadata(input, { client } = {}) {
      originalGate(); const target = validateScopedDocumentTarget(input);
      return transaction(target.scope, client, async connection => {
        if (!await originalAllowed(connection, target)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        return (await metadataRow(connection, target))?.document ?? null;
      });
    },
    async readOriginalCatalog(input, { client } = {}) {
      originalGate(); const target = validateScopedDocumentTarget(input);
      return transaction(target.scope, client, async connection => {
        if (!await originalAllowed(connection, target)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        const metadata = await metadataRow(connection, target);
        if (!metadata) return null;
        const result = await connection.query(`SELECT employee_id,dossier_revision,catalog_revision,
          metadata_revision,sha256,byte_size,object_generation,content_type,withdrawn
          FROM rh_private.contract_document_original_revisions
          WHERE tenant=$1 AND owner_id=$2 AND document_id=$3 AND version_id=$4
          ORDER BY catalog_revision DESC LIMIT 1`,
        [target.scope.tenant, target.scope.owner, target.documentId, target.versionId]);
        if (result.rows.length > 1) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        const row = result.rows[0];
        if (!row) return null;
        if (!Number.isInteger(row.catalog_revision) || row.catalog_revision < 1 || row.catalog_revision > 10000 ||
            row.withdrawn !== false || row.metadata_revision !== metadata.revision ||
            row.employee_id !== target.employeeId || row.dossier_revision !== target.dossierRevision) {
          fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        }
        return Object.freeze({ ...metadata.document, sha256: row.sha256, size: row.byte_size,
          generation: row.object_generation, contentType: row.content_type });
      });
    }
  });
}

module.exports = { createRhDocumentPostgresSource, documentAuthorityLockKey };

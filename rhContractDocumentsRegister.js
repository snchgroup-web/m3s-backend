'use strict';

const { validateDocumentTarget, validateScopedDocumentTarget, validateDocumentCandidate } = require('./rhDocumentLink.js');
const fail = code => { throw new Error(code); };

// Link persistence only; the host supplies identity and a live attachment decision.
function createContractDocumentRegister(pool, { enabled = false, authorizeAttachment, resolveDocument } = {}) {
  return Object.freeze({
    async attach(scope, input) {
      if (enabled !== true || typeof pool?.connect !== 'function' ||
          typeof authorizeAttachment !== 'function' || typeof resolveDocument !== 'function') {
        fail('RH_DOCUMENT_NOT_ENABLED');
      }
      const target = validateScopedDocumentTarget({ ...validateDocumentTarget(input), scope });
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SELECT set_config('m3s.tenant',$1,true),set_config('m3s.owner',$2,true)",
          [target.scope.tenant, target.scope.owner]);
        const context = Object.freeze({ client, target });
        async function allowed() {
          let result;
          try { result = await authorizeAttachment(context); }
          catch { fail('RH_DOCUMENT_SOURCE_UNAVAILABLE'); }
          if (result !== true) fail('RH_DOCUMENT_ATTACHMENT_DENIED');
        }
        await allowed();
        // Same dossier lock as the draft reviser; then a single document lock.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`rh-draft-v1:${target.scope.tenant}:${target.scope.owner}:${target.employeeId}`]);
        const dossier = await client.query(`SELECT revision,record_status,classification
          FROM rh_private.employee_revisions WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3
          ORDER BY revision DESC LIMIT 1`, [target.scope.tenant, target.scope.owner, target.employeeId]);
        if (!dossier.rows.length) fail('RH_DOCUMENT_DOSSIER_UNAVAILABLE');
        const latest = dossier.rows[0];
        if (latest.record_status !== 'draft' || latest.classification !== 'C3') fail('RH_DOCUMENT_NOT_ELIGIBLE');
        if (latest.revision !== target.dossierRevision) fail('RH_DOCUMENT_REVISION_CONFLICT');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`rh-contract-document-v1:${target.scope.tenant}:${target.scope.owner}:${target.documentId}`]);
        let document;
        try { document = await resolveDocument(context); }
        catch { fail('RH_DOCUMENT_SOURCE_UNAVAILABLE'); }
        validateDocumentCandidate(document, target);
        await allowed();
        const parameters = [target.scope.tenant, target.scope.owner, target.documentId];
        const root = await client.query(`SELECT employee_id FROM rh_private.contract_documents
          WHERE tenant=$1 AND owner_id=$2 AND document_id=$3`, parameters);
        if (root.rows.length && root.rows[0].employee_id !== target.employeeId) fail('RH_DOCUMENT_SCOPE_MISMATCH');
        const existing = await client.query(`SELECT employee_id,dossier_revision,purpose
          FROM rh_private.contract_document_links WHERE tenant=$1 AND owner_id=$2 AND document_id=$3 AND version_id=$4`,
        [...parameters, target.versionId]);
        if (existing.rows.length && (existing.rows[0].employee_id !== target.employeeId ||
            existing.rows[0].dossier_revision !== target.dossierRevision || existing.rows[0].purpose !== target.purpose)) {
          fail('RH_DOCUMENT_VERSION_CONFLICT');
        }
        if (!root.rows.length) {
          await client.query(`INSERT INTO rh_private.contract_documents(tenant,owner_id,document_id,employee_id)
            VALUES($1,$2,$3,$4)`, [...parameters, target.employeeId]);
        }
        if (!existing.rows.length) {
          await client.query(`INSERT INTO rh_private.contract_document_links
            (tenant,owner_id,document_id,version_id,employee_id,dossier_revision,purpose,category,classification,record_status,trashed)
            VALUES($1,$2,$3,$4,$5,$6,$7,'rh','C3','draft',false)`,
          [...parameters, target.versionId, target.employeeId, target.dossierRevision, target.purpose]);
        }
        await client.query('COMMIT');
        const references = { employeeId: target.employeeId, dossierRevision: target.dossierRevision,
          documentId: target.documentId, versionId: target.versionId, purpose: target.purpose };
        return Object.freeze({ ...references, category: 'rh', classification: 'C3',
          contractStatus: 'draft_not_signable', replayed: existing.rows.length > 0, localCandidate: true });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => { broken = true; });
        throw error;
      } finally { client.release(broken); }
    }
  });
}

module.exports = { createContractDocumentRegister };

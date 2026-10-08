'use strict';
const express = require('express');
const { createHash } = require('node:crypto');
const { scopeFor } = require('./rhReadPolicy');
const { createCurrentRhPolicy } = require('./rhReadPolicy');
const { createRhDocumentPostgresSource, documentAuthorityLockKey } = require('./rhDocumentPostgresSource');
const { validateDocumentTarget } = require('./rhDocumentLink');
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = x => createHash('sha256').update(x).digest('hex');
const fail = code => { throw new Error(code); };
const tables = ['schema_versions', 'entitlement_revisions', 'employee_revisions', 'contract_document_links',
  'contract_document_metadata_revisions', 'contract_document_original_revisions', 'document_original_decision_revisions'];

async function assertViewerAccess(client) {
  const { rows } = await client.query(`SELECT current_user role,rolcanlogin,rolinherit,rolsuper,rolcreatedb,
    rolcreaterole,rolreplication,rolbypassrls,(SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) memberships
    FROM pg_roles r WHERE rolname=current_user`);
  const role = rows[0];
  if (rows.length !== 1 || role.role !== 'm3s_rh_document_viewer' || role.memberships !== 0 ||
      ['rolcanlogin','rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(k => role[k] !== false)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
  const rights = await client.query(`SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
    c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) owns,
    has_schema_privilege(current_user,n.oid,'USAGE') usable,
    has_schema_privilege(current_user,n.oid,'CREATE') creatable,
    has_table_privilege(current_user,c.oid,'SELECT') readable,
    has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') writable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rh_private' AND c.relname=ANY($1::text[])`, [tables]);
  if (rights.rows.length !== tables.length || rights.rows.some(r => r.relkind !== 'r' || !r.relrowsecurity || !r.relforcerowsecurity ||
      r.owns !== false || r.usable !== true || r.creatable !== false || r.readable !== true || r.writable !== false)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
  const others = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    AND c.relkind IN ('r','v','m','p','f') AND NOT(n.nspname='rh_private' AND c.relname=ANY($1::text[]))
    AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR
      has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) allowed`,[tables]);
  if (others.rows.length !== 1 || others.rows[0].allowed !== false) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
  const versions = await client.query('SELECT version FROM rh_private.schema_versions');
  if (versions.rows.length !== 1 || versions.rows[0].version !== 'rh-read-v1') fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
}

function createViewerService({pool,getStore}) {
  const source = createRhDocumentPostgresSource({qualified:true, originalQualified:true, pool});
  const policy = createCurrentRhPolicy({qualified:true,readBindings:source.readOriginalRhBindings});
  async function read(principal, employeeId, revision, target) {
    const scope = await scopeFor(policy,principal,'read');
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SELECT set_config('m3s.tenant',$1,true),set_config('m3s.owner',$2,true)",[scope.tenant,scope.owner]);
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[documentAuthorityLockKey(scope)]);
      const entitlement = await client.query(`SELECT can_read FROM rh_private.entitlement_revisions
        WHERE tenant=$1 AND owner_id=$2 ORDER BY revision DESC LIMIT 1`,[scope.tenant,scope.owner]);
      if (entitlement.rows.length !== 1 || entitlement.rows[0].can_read !== true) fail('RH_DOCUMENT_ACCESS_DENIED');
      const checkDossier = async () => {
        const dossier = await client.query(`SELECT revision,record_status,classification FROM rh_private.employee_revisions
        WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 ORDER BY revision DESC LIMIT 1`,[scope.tenant,scope.owner,employeeId]);
        if (dossier.rows.length !== 1 || dossier.rows[0].revision !== revision || dossier.rows[0].record_status !== 'draft' ||
          dossier.rows[0].classification !== 'C3') fail('RH_DOCUMENT_ACCESS_DENIED');
      };
      await checkDossier();
      const links = await client.query(`SELECT document_id,version_id FROM rh_private.contract_document_links
        WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 AND dossier_revision=$4 AND purpose='contract_draft'
          AND category='rh' AND classification='C3' AND record_status='draft' AND NOT trashed
        ORDER BY document_id,version_id LIMIT 101`,[scope.tenant,scope.owner,employeeId,revision]);
      if (links.rows.length > 100) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
      const documents = [];
      let catalog;
      for (const row of links.rows) {
        if (![row.document_id,row.version_id].every(x => typeof x === 'string' && HASH.test(x))) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        if (target && (row.document_id !== target.documentId || row.version_id !== target.versionId)) continue;
        const reference = {scope,employeeId,dossierRevision:revision,documentId:row.document_id,versionId:row.version_id,purpose:'contract_draft'};
        if (!(await source.readOriginalBindings(reference,{client})).length) continue;
        const current = await source.readOriginalCatalog(reference,{client});
        if (!current || current.contentType !== 'application/pdf' || !HASH.test(current.sha256) ||
            !Number.isInteger(current.size) || current.size < 10 || current.size > 1048576 ||
            !/^[1-9][0-9]{0,29}$/.test(current.generation)) fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        documents.push({documentId:row.document_id,versionId:row.version_id,byteSize:current.size});
        if (target) catalog = current;
      }
      let bytes;
      if (target) {
        if (!catalog) fail('RH_DOCUMENT_ACCESS_DENIED');
        const store = await getStore();
        bytes = await store.get({key:`ged-private/v1/${scope.tenant}/${scope.owner}/${catalog.sha256}`,
          generation:catalog.generation,size:catalog.size,sha256:catalog.sha256});
        if (!Buffer.isBuffer(bytes) || bytes.length !== catalog.size || digest(bytes) !== catalog.sha256 ||
            bytes.subarray(0,5).toString() !== '%PDF-') fail('RH_DOCUMENT_SOURCE_UNAVAILABLE');
        const current = await source.readOriginalCatalog({scope,...target},{client});
        if (JSON.stringify(current) !== JSON.stringify(catalog)) fail('RH_DOCUMENT_ACCESS_DENIED');
        await checkDossier();
      }
      await client.query('COMMIT');
      return target ? bytes : {employeeId,dossierRevision:revision,documents};
    } catch(error) {
      try { await client.query('ROLLBACK'); } catch { broken=true; }
      throw error;
    } finally { client.release(broken); }
  }
  return {read};
}

function createViewerRuntime({enabled=false,identityRuntime,pool,getStore,origins=[]}={}) {
  const router = express.Router();
  const service = enabled && identityRuntime?.mode === 'google' && typeof pool?.connect === 'function' &&
    typeof getStore === 'function' ? createViewerService({pool,getStore}) : null;
  router.use((req,res,next) => {
    res.set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff');
    if (!service) return res.status(503).json({code:'RH_DOCUMENT_NOT_ENABLED'});
    if (!origins.includes(req.get('Origin'))) return res.status(403).json({code:'RH_ORIGIN_DENIED'});
    try { Promise.resolve(identityRuntime.authenticate(req,res,next)).catch(next); } catch(error) {next(error);}
  });
  const handler = original => async(req,res,next) => {
    try {
      if (req.user?.authProvider !== 'google') return res.status(401).json({code:'RH_AUTH_REQUIRED'});
      const employeeId = req.params.employeeId;
      const raw = req.query.dossierRevision;
      if (!UUID.test(employeeId) || Object.keys(req.query).join(',') !== 'dossierRevision' ||
          typeof raw !== 'string' || !/^[1-9][0-9]{0,3}$/.test(raw)) fail('RH_DOCUMENT_INVALID_FIELDS');
      const revision = Number(raw);
      const target = original ? validateDocumentTarget({employeeId,dossierRevision:revision,
        documentId:req.params.documentId,versionId:req.params.versionId,purpose:'contract_draft'}) : null;
      const result = await service.read(req.user,employeeId,revision,target);
      if (req.aborted || res.destroyed) return;
      if (original) return res.type('application/pdf').set('Content-Disposition','inline; filename="2SG-projet-contrat.pdf"')
        .set('Content-Security-Policy',"sandbox; default-src 'none'").send(result);
      res.json(result);
    } catch(error) {next(error);}
  };
  router.get('/employees/:employeeId/contract-documents',handler(false));
  router.get('/employees/:employeeId/contract-documents/:documentId/versions/:versionId',handler(true));
  router.use((error,req,res,next) => {
    if (res.headersSent) return next(error);
    const code = ['RH_ACCESS_DENIED','RH_DOCUMENT_ACCESS_DENIED','RH_DOCUMENT_INVALID_FIELDS','RH_DOCUMENT_INVALID_REFERENCE'].includes(error?.message) ? error.message : 'RH_DOCUMENT_SOURCE_UNAVAILABLE';
    res.status(code.includes('INVALID') ? 400 : code.includes('DENIED') ? 403 : 503).json({code});
  });
  return (req,res,next) => {
    if (req.method !== 'GET' || !/^\/employees\/[^/]+\/contract-documents(?:\/[^/]+\/versions\/[^/]+)?\/?$/.test(req.path)) return next();
    return router(req,res,next);
  };
}
module.exports = {assertViewerAccess,createViewerService,createViewerRuntime};

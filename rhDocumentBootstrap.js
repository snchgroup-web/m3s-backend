'use strict';

const { createRhDocumentAttachmentRuntime } = require('./rhDocumentRuntime.js');

async function assertConnectorAccess(client, { viewer = false } = {}) {
  await client.query('RESET ROLE');
  const result = await client.query(`SELECT session_user AS role,rolcanlogin,rolsuper,rolcreatedb,
    rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolconnlimit,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
    EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles w ON w.oid=m.roleid
      WHERE m.member=r.oid AND w.rolname='m3s_rh_document_writer'
        AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option) AS can_assume_writer,
    EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles w ON w.oid=m.roleid
      WHERE m.member=r.oid AND w.rolname='m3s_rh_document_viewer'
        AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option) AS can_assume_viewer,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r','v','m','p','f') AND
        (c.relowner=r.oid OR has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) AS direct_access
    FROM pg_roles r WHERE rolname=session_user`);
  const role = result.rows[0];
  if (result.rows.length !== 1 || role.role !== 'm3s_rh_document_connector' ||
      role.rolcanlogin !== true || role.rolconnlimit !== 2 || role.memberships !== (viewer ? 2 : 1) ||
      (viewer && role.can_assume_viewer !== true) ||
      role.can_assume_writer !== true || role.direct_access !== false ||
      ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','rolinherit']
        .some(key => role[key] !== false)) throw new Error('RH_DOCUMENT_SOURCE_UNAVAILABLE');
}

function documentDatabaseOptions(env = {}) {
  const password = env.M3S_RH_DOCUMENT_DB_PASSWORD;
  const ca = env.M3S_RH_DB_CA_PEM;
  if (typeof password !== 'string' || password.length < 32 ||
      password === env.M3S_RH_DB_PASSWORD || typeof ca !== 'string' ||
      !ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('RH_DOCUMENT_CONFIGURATION_UNAVAILABLE');
  return {
    host: 'postgres.railway.internal', port: 5432, database: 'railway',
    user: 'm3s_rh_document_connector', password,
    ssl: { ca, rejectUnauthorized: true }, max: 2,
    connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000,
    statement_timeout: 10000, query_timeout: 12000,
    idle_in_transaction_session_timeout: 15000,
    application_name: 'm3s-rh-document-attachment'
  };
}

function createRhDocumentHost({ env = {}, identityRuntime, origins, createPool = options => {
  const { Pool } = require('pg');
  return new Pool(options);
},
  warn = () => {}, createRuntime = createRhDocumentAttachmentRuntime } = {}) {
  const closed = () => ({ router: createRuntime(), close: async () => {} });
  if (env.M3S_RH_DOCUMENT_PROFILE !== 'rh-document-attachment-v1' ||
      identityRuntime?.mode !== 'google' || typeof identityRuntime.authenticate !== 'function') return closed();
  let pool;
  try {
    const options = documentDatabaseOptions(env);
    if (typeof createPool !== 'function') throw new Error('RH_DOCUMENT_CONFIGURATION_UNAVAILABLE');
    pool = createPool(options);
    if (!['connect', 'end', 'on'].every(key => typeof pool?.[key] === 'function')) {
      throw new Error('RH_DOCUMENT_CONFIGURATION_UNAVAILABLE');
    }
    pool.on('error', () => warn('RH_DOCUMENT_POOL_UNAVAILABLE'));
    // Keep the permission-bearing role NOLOGIN; the separate connector assumes it.
    const viewerEnabled = env.M3S_RH_DOCUMENT_VIEW_ENABLED === 'true';
    const checkout = role => ({ async connect() {
      const client = await pool.connect();
      try {
        await assertConnectorAccess(client, { viewer: viewerEnabled });
        await client.query(`SET ROLE ${role}`);
        if (role === 'm3s_rh_document_viewer') {
          await require('./rhDocumentViewer').assertViewerAccess(client);
        }
        return client;
      } catch {
        client.release(true);
        throw new Error('RH_DOCUMENT_SOURCE_UNAVAILABLE');
      }
    } });
    const attachmentRouter = createRuntime({ qualified: true, identityRuntime, origins,
      pool: checkout('m3s_rh_document_writer') });
    let router = attachmentRouter;
    if (viewerEnabled) {
      const { createViewerRuntime } = require('./rhDocumentViewer');
      let storage;
      const getStore = async () => {
        if (!storage) storage = (async () => {
          let credentials;
          const raw = env.GOOGLE_CREDENTIALS || '';
          for (const value of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
            try { const parsed = JSON.parse(value); if (parsed.private_key && parsed.client_email) { credentials=parsed; break; } } catch {}
          }
          if (credentials?.client_email !== 'm3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com') throw Error('RH_DOCUMENT_SOURCE_UNAVAILABLE');
          const { Storage } = require('@google-cloud/storage');
          const bucket = new Storage({credentials,projectId:'mon-projet-data-2sg',timeout:10000,
            retryOptions:{autoRetry:false,maxRetries:0}}).bucket('m3s-ged-prive-mon-projet-data-2sg');
          const { createPrivateObjectStore } = await import('./gedPrivateStorage.mjs');
          return createPrivateObjectStore({enabled:true,bucket,target:{bucketName:bucket.name,
            projectNumber:'39747051341',location:'EUROPE-WEST6',maxBytes:1048576}});
        })().catch(error => { storage=undefined; throw error; });
        return storage;
      };
      const viewerRouter = createViewerRuntime({enabled:true,identityRuntime,origins,
        pool:checkout('m3s_rh_document_viewer'),getStore});
      router = (req,res,next) => viewerRouter(req,res,() => attachmentRouter(req,res,next));
    }
    let closing;
    return { router, close: () => {
      closing ??= Promise.resolve().then(() => pool.end());
      return closing;
    } };
  } catch {
    if (typeof pool?.end === 'function') Promise.resolve().then(() => pool.end()).catch(() => {});
    warn('RH_DOCUMENT_CONFIGURATION_UNAVAILABLE');
    return closed();
  }
}

module.exports = { documentDatabaseOptions, createRhDocumentHost, assertConnectorAccess };

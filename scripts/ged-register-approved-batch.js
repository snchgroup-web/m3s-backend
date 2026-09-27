const { readPolicy, digest, approvedDocument, MAX_BYTES } = require('../gedPrivatePolicy');
const { databaseOptions, assertDatabaseAccess } = require('../gedPrivate');
const { createRegister } = require('../gedPrivateRegister');

// Operator-only reconciliation of pre-approved, privately staged bytes. This is
// not an HTTP authentication path and never fabricates an end-user session.
async function registerApprovedBatch({ policy, register, storage, readReference, confirmed }) {
  if (confirmed !== true || !policy) throw new Error('GED_BATCH_NOT_AUTHORIZED');
  const scope = { tenant: digest(policy.owner.organizationId), owner: digest(policy.owner.userId) };
  const verified = [];
  for (const entry of policy.documents) {
    const key = `ged-private/v1/${scope.tenant}/${scope.owner}/${entry.sha256}`;
    const ref = await readReference(key);
    if (ref.key !== key || ref.sha256 !== entry.sha256 || ref.size !== entry.size ||
        typeof ref.generation !== 'string' || !/^[1-9][0-9]{0,29}$/.test(ref.generation)) {
      throw new Error('GED_BATCH_INTEGRITY_FAILED');
    }
    approvedDocument(policy, entry.sha256, await storage.get(ref));
    verified.push({ entry, ref });
  }
  let created = 0;
  for (const { entry, ref } of verified) {
    const result = await register.create(scope, entry, ref.generation);
    if (result.created) created++;
    const row = await register.read(scope, entry.sha256);
    if (!row || row.generation !== ref.generation || row.byte_size !== entry.size || row.filename !== entry.name) {
      throw new Error('GED_BATCH_REGISTER_FAILED');
    }
    approvedDocument(policy, entry.sha256, await storage.get(ref));
  }
  return { verified: verified.length, created, existing: verified.length - created };
}

async function main() {
  let pool;
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--confirm-approved-batch') throw new Error('confirmation');
    const policy = readPolicy(process.env);
    if (!policy) throw new Error('disabled');
    const raw = process.env.GOOGLE_CREDENTIALS || '';
    let credentials;
    for (const value of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
      try { const parsed = JSON.parse(value); if (parsed.private_key && parsed.client_email) { credentials = parsed; break; } } catch {}
    }
    if (credentials?.client_email !== 'm3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com') throw new Error('identity');
    const { Pool } = require('pg');
    pool = new Pool(databaseOptions(process.env));
    pool.on('error', () => {});
    await assertDatabaseAccess(pool);
    const { Storage } = require('@google-cloud/storage');
    const bucket = new Storage({ credentials, projectId: 'mon-projet-data-2sg', timeout: 10000,
      retryOptions: { autoRetry: false, maxRetries: 0, totalTimeout: 15 } }).bucket('m3s-ged-prive-mon-projet-data-2sg');
    const { createPrivateObjectStore } = await import('../gedPrivateStorage.mjs');
    const storage = createPrivateObjectStore({ enabled: true, bucket, target: { bucketName: bucket.name,
      projectNumber: '39747051341', location: 'EUROPE-WEST6', maxBytes: policy.maxBytes || MAX_BYTES } });
    const result = await registerApprovedBatch({ policy, storage, register: createRegister(pool, { maxBytes: policy.maxBytes }), confirmed: true,
      readReference: async key => {
        const [m] = await bucket.file(key).getMetadata();
        if (m.name !== key || m.bucket !== bucket.name || m.contentType !== 'application/octet-stream' ||
            m.contentEncoding || m.cacheControl !== 'private, no-store' || typeof m.size !== 'string' ||
            !/^[1-9][0-9]{0,6}$/.test(m.size)) throw new Error('metadata');
        return { key, generation: m.generation, size: Number(m.size), sha256: m.metadata?.sha256 };
      } });
    console.log(JSON.stringify({ status: 'GED_BATCH_VERIFIED', ...result }));
  } catch {
    console.error('GED_BATCH_FAILED_NO_SECRET_OUTPUT');
    process.exitCode = 1;
  } finally { if (pool) await pool.end().catch(() => {}); }
}

if (require.main === module) main();
module.exports = { registerApprovedBatch };

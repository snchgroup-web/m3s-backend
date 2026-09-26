// The caller must authorize the actor before using this store.
// No SDK construction, credential discovery, environment reads or cloud provisioning.
import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const KEY = /^ged-private\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}$/;
const DECIMAL = /^[1-9][0-9]{0,29}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
class StoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new StoreError(code); };
const sanitize = error => {
  if (error instanceof StoreError) throw error;
  fail('STORAGE_UNAVAILABLE');
};

export function createPrivateObjectStore({ bucket, target, enabled = false } = {}) {
  if (enabled !== true) fail('STORAGE_NOT_ENABLED');
  if (!bucket || typeof bucket.getMetadata !== 'function' || typeof bucket.file !== 'function' ||
      !target || typeof target.bucketName !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(target.bucketName) ||
      typeof target.projectNumber !== 'string' || !DECIMAL.test(target.projectNumber) ||
      typeof target.location !== 'string' || !/^[A-Z][A-Z0-9-]{1,39}$/.test(target.location) ||
      !Number.isSafeInteger(target.maxBytes) || target.maxBytes < 1 ||
      target.maxBytes > 10 * 1024 * 1024) fail('INVALID_STORAGE_TARGET');
  const expected = Object.freeze({ ...target });

  const checkKey = key => {
    if (typeof key !== 'string' || !KEY.test(key)) fail('INVALID_OBJECT_KEY');
  };
  const checkTarget = async () => {
    const [metadata] = await bucket.getMetadata();
    if (!metadata || bucket.name !== expected.bucketName || metadata.name !== expected.bucketName ||
        metadata.projectNumber !== expected.projectNumber || metadata.location !== expected.location ||
        metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
        metadata.iamConfiguration?.publicAccessPrevention !== 'enforced') fail('STORAGE_POLICY_DENIED');
  };
  const readReference = (key, metadata) => {
    if (!metadata || metadata.name !== key || metadata.bucket !== expected.bucketName ||
        typeof metadata.generation !== 'string' || !DECIMAL.test(metadata.generation) ||
        typeof metadata.size !== 'string' || !DECIMAL.test(metadata.size) ||
        BigInt(metadata.size) > BigInt(expected.maxBytes) ||
        metadata.contentType !== 'application/octet-stream' ||
        metadata.contentEncoding || typeof metadata.metadata?.sha256 !== 'string' ||
        !HASH.test(metadata.metadata.sha256)) fail('STORAGE_INTEGRITY_FAILED');
    return { key, generation: metadata.generation, size: Number(metadata.size), sha256: metadata.metadata.sha256 };
  };
  const readBytes = async reference => {
    // Pin the generation: a concurrent replacement must not change this download.
    const stream = bucket.file(reference.key, { generation: reference.generation })
      .createReadStream({ validation: 'crc32c', decompress: false });
    const chunks = [];
    let size = 0;
    const timeout = setTimeout(() => stream.destroy(new StoreError('STORAGE_UNAVAILABLE')), 15000);
    timeout.unref();
    try {
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) fail('STORAGE_INTEGRITY_FAILED');
        size += chunk.length;
        if (size > reference.size) fail('STORAGE_INTEGRITY_FAILED');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      if (size !== reference.size || digest(bytes) !== reference.sha256) fail('STORAGE_INTEGRITY_FAILED');
      return bytes;
    } finally {
      clearTimeout(timeout);
      stream.destroy();
    }
  };

  return Object.freeze({
    async putIfAbsent({ key, bytes } = {}) {
      checkKey(key);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > expected.maxBytes) fail('INVALID_OBJECT_BYTES');
      const copy = Buffer.from(bytes);
      const sha256 = digest(copy);
      try {
        await checkTarget();
        const file = bucket.file(key);
        let created = true;
        try {
          await file.save(copy, {
            resumable: false, validation: 'crc32c',
            preconditionOpts: { ifGenerationMatch: 0 },
            metadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store',
              metadata: { sha256 } }
          });
        } catch (error) {
          if (error?.code !== 412 && error?.code !== '412') throw error;
          created = false;
        }
        const [metadata] = await file.getMetadata();
        const reference = readReference(key, metadata);
        if (reference.sha256 !== sha256 || reference.size !== copy.length) fail('OBJECT_CONFLICT');
        await readBytes(reference);
        return { ...reference, created };
      } catch (error) { sanitize(error); }
    },
    // Reference must come from the authorized server-side GED record, not request fields.
    async get(reference) {
      if (!reference || typeof reference !== 'object') fail('INVALID_OBJECT_REFERENCE');
      const snapshot = { ...reference };
      checkKey(snapshot.key);
      if (typeof snapshot.generation !== 'string' || !DECIMAL.test(snapshot.generation) ||
          typeof snapshot.sha256 !== 'string' || !HASH.test(snapshot.sha256) ||
          !Number.isSafeInteger(snapshot.size) || snapshot.size < 1 ||
          snapshot.size > expected.maxBytes) fail('INVALID_OBJECT_REFERENCE');
      try {
        await checkTarget();
        return await readBytes(snapshot);
      } catch (error) { sanitize(error); }
    }
  });
}

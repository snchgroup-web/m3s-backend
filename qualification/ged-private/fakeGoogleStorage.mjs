import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createGoogleStorageCandidate } from './googleStorageCandidate.mjs';

export const target = Object.freeze({ bucketName: 'fixture-private-bucket', projectNumber: '123456789',
  location: 'EUROPE-WEST6', maxBytes: 64 * 1024 });
export const providerError = code => Object.assign(new Error('Provider detail must not escape'), { code });

// SDK-shaped in-memory fake only. No Storage SDK, environment or network client.
export function createFakeGoogleStorage({ maxBytes = target.maxBytes } = {}) {
  const calls = [];
  const versions = new Map();
  const latest = new Map();
  const state = { sequence: 9007199254740993n, saveError: null, readError: null,
    metadataError: null, mutateMetadata: null, streamBytes: null, afterSave: null,
    beforeTarget: null, stream: null };
  const policy = { name: target.bucketName, projectNumber: target.projectNumber,
    location: target.location, iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } };
  const bucket = {
    name: target.bucketName,
    async getMetadata() {
      calls.push(['target']);
      await state.beforeTarget?.();
      if (state.metadataError) throw state.metadataError;
      return [structuredClone(policy)];
    },
    file(name, options = {}) {
      calls.push(['file', name, structuredClone(options)]);
      return {
        async save(content, saveOptions) {
          calls.push(['save', name, structuredClone(saveOptions)]);
          assert.equal(saveOptions.preconditionOpts.ifGenerationMatch, 0);
          if (state.saveError) throw state.saveError;
          if (latest.has(name)) throw providerError(412);
          const generation = String(state.sequence++);
          const metadata = { name, bucket: bucket.name, generation, size: String(content.length),
            ...structuredClone(saveOptions.metadata) };
          const record = { bytes: Buffer.from(content), metadata };
          versions.set(`${name}:${generation}`, record);
          latest.set(name, record);
          await state.afterSave?.();
        },
        async getMetadata() {
          calls.push(['objectMetadata', name]);
          const record = latest.get(name);
          if (!record) throw providerError(404);
          const metadata = structuredClone(record.metadata);
          state.mutateMetadata?.(metadata);
          return [metadata];
        },
        createReadStream(readOptions) {
          calls.push(['read', name, structuredClone(options), structuredClone(readOptions)]);
          const record = versions.get(`${name}:${options.generation}`);
          const stream = Readable.from((async function* () {
            if (state.readError) throw state.readError;
            if (!record) throw providerError(404);
            yield state.streamBytes ?? Buffer.from(record.bytes);
          })());
          state.stream = stream;
          return stream;
        }
      };
    }
  };
  return { bucket, calls, policy, state, latest, versions,
    store: createGoogleStorageCandidate({ bucket, target: { ...target, maxBytes }, enabled: true }) };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGoogleStorageCandidate } from './googleStorageCandidate.mjs';
import { createFakeGoogleStorage, target as fixtureTarget, providerError as error } from './fakeGoogleStorage.mjs';

const key = `ged-private/v1/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}`;
const bytes = Buffer.from('SYNTHETIC GED FIXTURE\nStorage candidate test');
const sha = value => createHash('sha256').update(value).digest('hex');
const target = Object.freeze({ ...fixtureTarget, maxBytes: 1024 });
const fixture = () => createFakeGoogleStorage({ maxBytes: 1024 });

test('disabled by default without touching dependencies', () => {
  let called = false;
  assert.throws(() => createGoogleStorageCandidate({
    bucket: { getMetadata() { called = true; } }, target
  }), { code: 'STORAGE_NOT_ENABLED' });
  assert.equal(called, false);
});

test('explicit bounded target required, no default bucket or environment discovery', () => {
  const f = fixture();
  for (const change of [{ bucketName: '../bucket' }, { projectNumber: 123 },
    { location: '' }, { maxBytes: Infinity }, { maxBytes: 0 }, { maxBytes: 11 * 1024 * 1024 }]) {
    assert.throws(() => createGoogleStorageCandidate({ bucket: f.bucket,
      target: { ...target, ...change }, enabled: true }), { code: 'INVALID_STORAGE_TARGET' });
  }
  assert.equal(f.calls.length, 0);
});

test('create, verified read-back and download pinned to string generation', async () => {
  const f = fixture();
  const reference = await f.store.putIfAbsent({ key, bytes });
  assert.deepEqual(reference, { key, generation: '9007199254740993', size: bytes.length,
    sha256: sha(bytes), created: true });
  assert.deepEqual(await f.store.get(reference), bytes);
  const save = f.calls.find(call => call[0] === 'save')[2];
  assert.equal(save.resumable, false);
  assert.equal(save.validation, 'crc32c');
  assert.equal(save.metadata.cacheControl, 'private, no-store');
  assert.equal(save.metadata.contentType, 'application/octet-stream');
  assert.equal('predefinedAcl' in save, false);
  for (const read of f.calls.filter(call => call[0] === 'read')) {
    assert.deepEqual(read[2], { generation: '9007199254740993' });
    assert.deepEqual(read[3], { validation: 'crc32c', decompress: false });
  }
  assert.equal(f.state.stream.destroyed, true);
});

test('retry verifies duplicate bytes, never overwrites', async () => {
  const f = fixture();
  const first = await f.store.putIfAbsent({ key, bytes });
  const second = await f.store.putIfAbsent({ key, bytes });
  assert.deepEqual(second, { ...first, created: false });
  assert.equal(f.versions.size, 1);
});

test('concurrent creation publishes exactly one version', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.store.putIfAbsent({ key, bytes })));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(f.versions.size, 1);
});

test('same key with different bytes is a conflict, not a successful duplicate', async () => {
  const f = fixture();
  await f.store.putIfAbsent({ key, bytes });
  await assert.rejects(f.store.putIfAbsent({ key, bytes: Buffer.from('different fixture') }),
    { code: 'OBJECT_CONFLICT' });
  assert.deepEqual(f.latest.get(key).bytes, bytes);
});

for (const [label, mutate] of [
  ['bucket', f => { f.policy.name = 'wrong-bucket'; }],
  ['handle', f => { f.bucket.name = 'wrong-bucket'; }],
  ['project', f => { f.policy.projectNumber = '987654321'; }],
  ['location', f => { f.policy.location = 'US'; }],
  ['ACL mode', f => { f.policy.iamConfiguration.uniformBucketLevelAccess.enabled = false; }],
  ['public access prevention', f => { f.policy.iamConfiguration.publicAccessPrevention = 'inherited'; }],
  ['missing policy', f => { delete f.policy.iamConfiguration; }]
]) {
  test(`deny ${label} mismatch before any object operation`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.store.putIfAbsent({ key, bytes }), { code: 'STORAGE_POLICY_DENIED' });
    assert.deepEqual(f.calls, [['target']]);
  });
}

test('policy is checked again on download; a formerly valid bucket is not trusted forever', async () => {
  const f = fixture();
  const reference = await f.store.putIfAbsent({ key, bytes });
  f.policy.iamConfiguration.publicAccessPrevention = 'inherited';
  f.calls.length = 0;
  await assert.rejects(f.store.get(reference), { code: 'STORAGE_POLICY_DENIED' });
  assert.deepEqual(f.calls, [['target']]);
});

test('invalid keys, bytes and references produce zero provider calls', async () => {
  const f = fixture();
  for (const invalid of ['../private', 'https://example.com/doc', 'gs://fixture/key', {}, key + '/extra']) {
    await assert.rejects(f.store.putIfAbsent({ key: invalid, bytes }), { code: 'INVALID_OBJECT_KEY' });
  }
  for (const invalid of ['', Buffer.alloc(0), Buffer.alloc(1025), new Uint8Array(1)]) {
    await assert.rejects(f.store.putIfAbsent({ key, bytes: invalid }), { code: 'INVALID_OBJECT_BYTES' });
  }
  for (const invalid of [null, { key }, { key, generation: 9007199254740993, sha256: sha(bytes), size: bytes.length },
    { key, generation: '1', sha256: 'bad', size: bytes.length },
    { key, generation: '1', sha256: sha(bytes), size: 1025 }]) {
    await assert.rejects(f.store.get(invalid), { code: 'INVALID_OBJECT_REFERENCE' });
  }
  assert.equal(f.calls.length, 0);
});

test('download remains on the saved generation after a replacement', async () => {
  const f = fixture();
  const reference = await f.store.putIfAbsent({ key, bytes });
  f.latest.set(key, { metadata: { generation: '9007199254740994' }, bytes: Buffer.from('replacement') });
  assert.deepEqual(await f.store.get(reference), bytes);
});

test('caller mutation during an asynchronous operation cannot change upload or download target', async () => {
  const f = fixture();
  const input = Buffer.from(bytes);
  f.state.beforeTarget = () => input.fill(0);
  const reference = await f.store.putIfAbsent({ key, bytes: input });
  assert.equal(reference.sha256, sha(bytes));
  f.state.beforeTarget = () => { reference.generation = '2'; reference.size = 0; };
  assert.deepEqual(await f.store.get(reference), bytes);
});

test('corrupt, truncated or oversized streams are refused and closed', async () => {
  const f = fixture();
  const reference = await f.store.putIfAbsent({ key, bytes });
  for (const invalid of [Buffer.alloc(bytes.length), bytes.subarray(1), Buffer.alloc(1025)]) {
    f.state.streamBytes = invalid;
    await assert.rejects(f.store.get(reference), { code: 'STORAGE_INTEGRITY_FAILED' });
    assert.equal(f.state.stream.destroyed, true);
  }
});

test('untrusted metadata cannot become a successful reference', async () => {
  for (const mutate of [m => { m.size = '999999999999999999999999'; },
    m => { m.generation = 42; }, m => { m.name = 'other'; }, m => { m.bucket = 'other'; },
    m => { m.contentEncoding = 'gzip'; }, m => { m.contentType = 'text/html'; },
    m => { delete m.metadata; }, m => { m.metadata.sha256 = 'invalid'; }]) {
    const f = fixture();
    f.state.mutateMetadata = mutate;
    await assert.rejects(f.store.putIfAbsent({ key, bytes }), { code: 'STORAGE_INTEGRITY_FAILED' });
    assert.equal(f.calls.some(call => call[0] === 'read'), false);
  }
});

test('provider errors are sanitized and no delete or retry is attempted', async () => {
  for (const code of [403, 429, 500, 'ECONNRESET']) {
    const f = fixture();
    f.state.saveError = error(code);
    await assert.rejects(f.store.putIfAbsent({ key, bytes }),
      { code: 'STORAGE_UNAVAILABLE', message: 'STORAGE_UNAVAILABLE' });
    assert.equal(f.calls.filter(call => call[0] === 'save').length, 1);
    assert.equal(f.calls.some(call => call[0] === 'objectMetadata'), false);
  }
});

test('failed read-back is not reported as success; retry can recover the existing object', async () => {
  const f = fixture();
  f.state.afterSave = () => { f.state.readError = error('CONTENT_DOWNLOAD_MISMATCH'); };
  await assert.rejects(f.store.putIfAbsent({ key, bytes }), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(f.versions.size, 1);
  f.state.readError = null;
  const recovered = await f.store.putIfAbsent({ key, bytes });
  assert.equal(recovered.created, false);
  assert.deepEqual(await f.store.get(recovered), bytes);
});

test('unreadable bucket metadata prevents writes', async () => {
  const f = fixture();
  f.state.metadataError = error(403);
  await assert.rejects(f.store.putIfAbsent({ key, bytes }), { code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(f.calls, [['target']]);
});

test('missing pinned generation is unavailable, never falls back to latest', async () => {
  const f = fixture();
  const reference = await f.store.putIfAbsent({ key, bytes });
  f.versions.clear();
  await assert.rejects(f.store.get(reference), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(f.state.stream.destroyed, true);
});

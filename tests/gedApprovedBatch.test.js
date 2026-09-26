const test = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../gedPrivatePolicy');
const { registerApprovedBatch } = require('../scripts/ged-register-approved-batch');

function fixture() {
  const bytes = Buffer.from('%PDF-1.4 synthetic fixture');
  const entry = { name: 'Synthetic.pdf', size: bytes.length, sha256: digest(bytes) };
  const policy = { owner: { userId: 'synthetic-user', organizationId: 'synthetic-org' }, documents: [entry] };
  const rows = new Map();
  const register = {
    async create(scope, doc, generation) {
      assert.equal(scope.owner, digest(policy.owner.userId));
      const created = !rows.has(doc.sha256);
      if (created) rows.set(doc.sha256, { filename: doc.name, byte_size: doc.size, generation });
      return { created };
    },
    async read(_scope, id) { return rows.get(id); }
  };
  return { policy, rows, register, confirmed: true, storage: { get: async () => bytes },
    readReference: async key => ({ key, size: entry.size, sha256: entry.sha256, generation: '12345' }) };
}

test('operator batch verifies private bytes and is idempotent without user impersonation', async () => {
  const f = fixture();
  assert.deepEqual(await registerApprovedBatch(f), { verified: 1, created: 1, existing: 0 });
  assert.deepEqual(await registerApprovedBatch(f), { verified: 1, created: 0, existing: 1 });
});

test('operator batch requires explicit confirmation and an enabled policy', async () => {
  for (const patch of [{ confirmed: false }, { policy: null }]) {
    const f = fixture();
    await assert.rejects(registerApprovedBatch({ ...f, ...patch }), /NOT_AUTHORIZED/);
    assert.equal(f.rows.size, 0);
  }
});

test('no SQL writes occur until all source bytes and references pass verification', async () => {
  for (const patch of [
    { storage: { get: async () => Buffer.from('wrong') } },
    { readReference: async key => ({ key, generation: '12345', size: 1, sha256: 'a'.repeat(64) }) }
  ]) {
    const f = fixture();
    await assert.rejects(registerApprovedBatch({ ...f, ...patch }));
    assert.equal(f.rows.size, 0);
  }
  const f = fixture();
  f.policy.documents.push({ name: 'Another.pdf', sha256: 'a'.repeat(64), size: 40 });
  await assert.rejects(registerApprovedBatch(f));
  assert.equal(f.rows.size, 0);
});

test('missing persisted row does not report success', async () => {
  const f = fixture();
  f.register.read = async () => null;
  await assert.rejects(registerApprovedBatch(f), /REGISTER_FAILED/);
});

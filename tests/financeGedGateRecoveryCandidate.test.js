'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { digest, scopeFor } = require('../gedPrivatePolicy');
const { recoverFinancialDecisionGate } = require('../financeGedGateRecoveryCandidate');

function fixture({ trashed = false } = {}) {
  const bytes = Buffer.from('%PDF-1.4\nfictional financial decision\n%%EOF');
  const root = digest(bytes);
  const principal = { id: 'fixture-owner', tenantId: '2sg', authProvider: 'google' };
  const policy = { owner: { userId: principal.id, organizationId: principal.tenantId },
    documents: [{ sha256: root, name: 'Decision.pdf', size: bytes.length, category: 'finance' }] };
  const scope = scopeFor(policy, principal);
  let locked = false, thaws = 0, reads = 0;
  const row = { root_id: root, document_id: root, tenant: scope.tenant, owner_id: scope.owner,
    revision: 0, trashed, byte_size: bytes.length, generation: '123' };
  const register = { lifecycle: { async withLockedRoot(received, id, work) {
    assert.deepEqual(received, scope); assert.equal(id, root); locked = true;
    try { return await work(row); } finally { locked = false; }
  } } };
  const storage = { async get(reference) { assert.equal(locked, true); reads++; assert.equal(reference.sha256, root); return bytes; } };
  const gate = { async thaw(token) { assert.equal(locked, true); assert.equal(token.documentId, root); thaws++; return 5; } };
  const token = { actorId: principal.id, tenantId: principal.tenantId, documentId: root, revision: -5,
    expectedRevision: 0, operationId: 'synthetic' };
  return { input: { token, principal, policy, register, storage, gate, pinnedRoot: root }, row,
    state: () => ({ locked, thaws, reads }) };
}

test('fictional recovery verifies the current document before thawing under the owner lock', async () => {
  const f = fixture();
  assert.deepEqual(await recoverFinancialDecisionGate(f.input), { status: 'verified_and_reopened',
    document_revision: 0, document_trashed: false, gate_revision: 5 });
  assert.deepEqual(f.state(), { locked: false, thaws: 1, reads: 1 });
});

test('fictional recovery preserves a trashed state instead of restoring the document', async () => {
  const f = fixture({ trashed: true });
  const result = await recoverFinancialDecisionGate(f.input);
  assert.equal(result.document_trashed, true);
  assert.deepEqual(f.state(), { locked: false, thaws: 1, reads: 0 });
});

test('foreign identity, damaged evidence or an unavailable store never thaws the gate', async () => {
  const f = fixture();
  await assert.rejects(recoverFinancialDecisionGate({ ...f.input, principal: { ...f.input.principal, id: 'foreign' } }));
  await assert.rejects(recoverFinancialDecisionGate({ ...f.input, storage: { get: async () => Buffer.from('wrong') } }));
  f.row.owner_id = digest('other');
  await assert.rejects(recoverFinancialDecisionGate(f.input));
  assert.equal(f.state().thaws, 0);
});

test('unexplained GED revisions or a missing expected revision leave the gate closed', async () => {
  const f = fixture(); f.row.revision = 2;
  await assert.rejects(recoverFinancialDecisionGate(f.input));
  await assert.rejects(recoverFinancialDecisionGate({ ...f.input, token: { ...f.input.token, expectedRevision: undefined } }));
  assert.equal(f.state().thaws, 0);
});

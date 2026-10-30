'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinanceGedGateCandidate, createFinancialDecisionMutationGuard } = require('../financeGedGateCandidate');

const input = () => ({ tenantId: '2sg', actorId: 'fixture-user', documentId: 'a'.repeat(64), expectedRevision: 0 });
function setup({ freezeResponseLost = false, thawResponseLost = false } = {}) {
  let revision = 4;
  const events = [], queries = [];
  const bigquery = { async query(request) {
    queries.push(request);
    if (request.query.includes('SET revision=-revision-1')) {
      if (revision < 0) throw Error('busy');
      revision = -revision - 1;
      events.push({ id: request.params.operation_id, actor: request.params.actor_id,
        tenant: request.params.tenant_id, document: request.params.document_id, revision,
        expectedRevision: request.params.expected_revision, action: 'freeze' });
      if (freezeResponseLost) throw Error('response lost');
      return [[{ revision }]];
    }
    if (request.query.includes('SET revision=-revision')) {
      const event = events.find(e => e.id === request.params.operation_id && e.actor === request.params.actor_id &&
        e.tenant === request.params.tenant_id && e.document === request.params.document_id &&
        e.revision === request.params.frozen_revision && e.action === 'freeze');
      if (!event) throw Error('wrong gate');
      if (revision === request.params.frozen_revision) {
        revision = -revision;
        events.push({ id: request.params.thaw_id, actor: request.params.actor_id,
          tenant: request.params.tenant_id, document: request.params.document_id, action: 'thaw' });
      } else if (revision < -request.params.frozen_revision || !events.some(e => e.id === request.params.thaw_id &&
          e.actor === request.params.actor_id && e.tenant === request.params.tenant_id && e.document === request.params.document_id)) {
        throw Error('wrong gate');
      }
      if (thawResponseLost) throw Error('response lost');
      return [[{ revision }]];
    }
    if (request.query.includes('FROM `test-project.test_data.administration_task_registry_state` s JOIN')) {
      const matches = events.filter(e => e.action === 'freeze' && e.revision === revision && revision < 0 &&
        e.actor === request.params.actor_id && e.tenant === request.params.tenant_id && e.document === request.params.document_id);
      return [matches.map(e => ({ revision, operation_id: e.id, expected_revision: e.expectedRevision }))];
    }
    throw Error('unexpected');
  } };
  return { gate: createFinanceGedGateCandidate({ bigquery, projectId: 'test-project', datasetId: 'test_data' }),
    state: () => ({ revision, events, queries }) };
}

test('fictional gate freezes, runs the mutation, then thaws with a traced token', async () => {
  const f = setup();
  const result = await f.gate.protectMutation(input(), async () => {
    assert.equal(f.state().revision, -5);
    return 'synthetic result';
  });
  assert.equal(result, 'synthetic result');
  assert.equal(f.state().revision, 5);
  assert.deepEqual(f.state().events.map(event => event.action), ['freeze', 'thaw']);
  assert.match(f.state().queries[0].query, /revision>=0/);
  assert.match(f.state().queries[0].query, /frozen_revision/);
  assert.match(f.state().queries[1].query, /revision=@frozen_revision/);
  assert.match(f.state().queries[1].query, /action='freeze'/);
});

test('fictional gate never thaws after a failed or uncertain document mutation', async () => {
  const f = setup();
  await assert.rejects(f.gate.protectMutation(input(), async () => { throw Error('uncertain commit'); }));
  assert.equal(f.state().revision, -5);
  assert.deepEqual(f.state().events.map(event => event.action), ['freeze']);
});

test('a confirmed GED rollback safely releases the gate and preserves the original conflict', async () => {
  const f = setup();
  const conflict = Object.assign(Error('GED_VERSION_CONFLICT'), { code: 'GED_VERSION_CONFLICT', gedRollbackConfirmed: true });
  await assert.rejects(f.gate.protectMutation(input(), async () => { throw conflict; }), { code: 'GED_VERSION_CONFLICT' });
  assert.equal(f.state().revision, 5);
  assert.deepEqual(f.state().events.map(event => event.action), ['freeze', 'thaw']);
});

test('uncertain freeze does not run a document mutation or attempt an automatic thaw', async () => {
  const f = setup({ freezeResponseLost: true });
  let mutated = false;
  await assert.rejects(f.gate.protectMutation(input(), async () => { mutated = true; }));
  assert.equal(mutated, false);
  assert.equal(f.state().revision, -5);
  assert.equal(f.state().queries.length, 1);
  const token = await f.gate.findFrozen(input());
  assert.equal(token.revision, -5);
  assert.equal(token.expectedRevision, 0);
  assert.equal(f.state().revision, -5);
});

test('the fictional frozen-token lookup refuses another actor or document and never mutates state', async () => {
  const f = setup(); await f.gate.freeze(input());
  await assert.rejects(f.gate.findFrozen({ ...input(), actorId: 'other' }));
  await assert.rejects(f.gate.findFrozen({ ...input(), documentId: 'b'.repeat(64) }));
  assert.equal(f.state().revision, -5);
});

test('a lost thaw response is not reported as a successful operation', async () => {
  const f = setup({ thawResponseLost: true });
  await assert.rejects(f.gate.protectMutation(input(), async () => 'changed'));
  assert.equal(f.state().revision, 5);
  assert.equal(f.state().queries.length, 2);
});

test('repeating the same thaw is idempotent and adds no duplicate audit event', async () => {
  const f = setup(); const token = await f.gate.freeze(input());
  assert.equal(await f.gate.thaw(token), 5);
  assert.equal(await f.gate.thaw(token), 5);
  assert.deepEqual(f.state().events.map(event => event.action), ['freeze', 'thaw']);
});

test('invalid input or a forged thaw cannot open the fictional gate', async () => {
  const f = setup();
  await assert.rejects(f.gate.freeze({ ...input(), documentId: 'wrong' }));
  assert.equal(f.state().queries.length, 0);
  const token = await f.gate.freeze(input());
  await assert.rejects(f.gate.thaw({ ...token, actorId: 'other-user' }));
  assert.equal(f.state().revision, token.revision);
  await assert.rejects(f.gate.freeze(input()));
  assert.equal(f.state().revision, token.revision);
});

test('GED guard protects only the pinned decision and derives identity from the authenticated request', async () => {
  const calls = [], gate = { async protectMutation(value, mutate) { calls.push(value); return mutate(); } };
  const documentId = 'a'.repeat(64);
  const guard = createFinancialDecisionMutationGuard({ gate, documentId, canManage: () => true });
  const request = { params: { id: documentId }, user: { id: 'fixture-user', tenantId: '2sg' }, body: { expectedRevision: 1 } };
  assert.equal(await guard(request, async () => 'protected'), 'protected');
  assert.deepEqual(calls, [{ tenantId: '2sg', actorId: 'fixture-user', documentId, expectedRevision: 1 }]);
  assert.equal(await guard({ ...request, params: { id: 'b'.repeat(64) } }, async () => 'ordinary'), 'ordinary');
  assert.equal(calls.length, 1);
  const denied = createFinancialDecisionMutationGuard({ gate, documentId, canManage: () => false });
  assert.throws(() => denied(request, () => 'wrong'), { code: 'GED_ACCESS_DENIED' });
  assert.throws(() => guard({ ...request, body: {} }, () => 'wrong'), { code: 'GED_VERSION_CONFLICT' });
  assert.equal(calls.length, 1);
});

test('a delayed GED mutation refuses to proceed if recovery already reopened the gate', async () => {
  const f = setup(); let mutated = false;
  await assert.rejects(f.gate.protectMutation(input(), async verifyInsideLock => {
    const token = await f.gate.findFrozen(input());
    await f.gate.thaw(token);
    await verifyInsideLock();
    mutated = true;
  }));
  assert.equal(mutated, false);
  assert.equal(f.state().revision, 5);
});

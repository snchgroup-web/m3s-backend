'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCurrentReturnPolicy } = require('./rh-return-current-policy.cjs');
const decision = { tenant: 'a'.repeat(64), owner: 'b'.repeat(64), actor: 'c'.repeat(64),
  employeeId: '11111111-1111-4111-8111-111111111111', dossierRevision: 2,
  period: '2026-09', kind: 'salary', permission: 'observe_return' };
const context = () => ({ scope: { tenant: decision.tenant, owner: decision.owner, actor: decision.actor },
  target: { employeeId: decision.employeeId, dossierRevision: 2, period: '2026-09', kind: 'salary' } });

test('unqualified policy refuses without consulting a source', async () => {
  let calls = 0;
  const policy = createCurrentReturnPolicy({ readDecisions() { calls++; } });
  assert.equal(await policy.authorizeObservation(context()), false);
  assert.equal(calls, 0);
});

test('decision must match every scope and target field', async () => {
  const policy = createCurrentReturnPolicy({ syntheticOnly: true, readDecisions: async () => [{ ...decision }] });
  assert.equal(await policy.authorizeObservation(context()), true);
  for (const field of ['tenant', 'owner', 'actor']) {
    const changed = context(); changed.scope[field] = 'd'.repeat(64);
    assert.equal(await policy.authorizeObservation(changed), false);
  }
  for (const [field, value] of [['employeeId', '22222222-2222-4222-8222-222222222222'],
    ['dossierRevision', 3], ['period', '2026-10'], ['kind', 'hours']]) {
    const changed = context(); changed.target[field] = value;
    assert.equal(await policy.authorizeObservation(changed), false);
  }
});

test('withdrawal is observed on every invocation without caching', async () => {
  let active = true, calls = 0;
  const policy = createCurrentReturnPolicy({ syntheticOnly: true, readDecisions: async lookup => {
    calls++; assert.equal(Object.isFrozen(lookup), true);
    assert.deepEqual(Object.keys(lookup).sort(), Object.keys(decision).sort());
    return active ? [{ ...decision }] : [];
  } });
  assert.equal(await policy.authorizeObservation(context()), true);
  active = false;
  assert.equal(await policy.authorizeObservation(context()), false);
  assert.equal(calls, 2);
});

test('generic contract rights and malformed sources cannot grant observation', async () => {
  for (const result of [[{ ...decision, permission: 'revise' }], [{ ...decision, can_revise: true }],
    [{ ...decision, period: '*' }], Array(101).fill(decision), null]) {
    const policy = createCurrentReturnPolicy({ syntheticOnly: true, readDecisions: async () => result });
    await assert.rejects(policy.authorizeObservation(context()), { message: 'RH_RETURN_DECISION_SOURCE_UNAVAILABLE' });
  }
  const unavailable = createCurrentReturnPolicy({ syntheticOnly: true, readDecisions: async () => { throw Error('private details'); } });
  await assert.rejects(unavailable.authorizeObservation(context()), { message: 'RH_RETURN_DECISION_SOURCE_UNAVAILABLE' });
});

test('invalid context never reaches the decision source', async () => {
  let calls = 0;
  const policy = createCurrentReturnPolicy({ syntheticOnly: true, readDecisions: async () => { calls++; return [decision]; } });
  assert.equal(await policy.authorizeObservation(null), false);
  const invalid = context(); invalid.target.employeeId = 'not-an-id';
  assert.equal(await policy.authorizeObservation(invalid), false);
  assert.equal(calls, 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdministrationRegistryHandlers, PERMISSIONS } = require('../administrationRegistries');

const source = 'COR-fixture-finance';
const user = { id: 'fixture-user', tenantId: '2sg', name: 'Fixture',
  permissions: [PERMISSIONS.CORRESPONDENCE_WRITE, PERMISSIONS.CORRESPONDENCE_READ] };
const payload = { receipt_date: '2026-10-30', direction: 'incoming', channel: 'email', sender: 'Fixture',
  recipient: 'Fixture', subject: 'Synthetic source', category: 'supplier', confidentiality: 'internal',
  linked_person_or_case: '', ged_reference: '', receipt_evidence_reference: '', owner: 'Fixture',
  next_action: '', status: 'in_progress', deadline: '' };
function fixture({ coordinated = true, failFence = false, coordinatedIds = [] } = {}) {
  const calls = [];
  const bigquery = { async query(options) {
    calls.push(options);
    if (options.query.includes('SELECT id, confidentiality, created_by_user_id')) return [[{ id: options.params.id }]];
    if (options.query.includes('BEGIN TRANSACTION')) {
      if (failFence && options.query.includes('ADMIN_REGISTRY_COORDINATION_UNAVAILABLE'))
        throw Error('ADMIN_REGISTRY_COORDINATION_UNAVAILABLE');
      return [[{ id: options.params.id }]];
    }
    throw Error('unexpected synthetic query');
  } };
  const handlers = createAdministrationRegistryHandlers({ bigquery, projectId: 'test-project', datasetId: 'test_data',
    coordinatedCorrespondenceId: coordinated ? source : undefined, coordinatedCorrespondenceIds: coordinatedIds,
    logger: { error() {} } });
  return { calls, async call(method, id = source) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handlers[method]({ user, params: { id }, body: payload }, res);
    return res;
  } };
}

test('only the coordinated correspondence shares the task fence during updates and deletion', async () => {
  for (const method of ['updateCorrespondence', 'deleteCorrespondence']) {
    const f = fixture();
    assert.equal((await f.call(method)).statusCode, 200);
    const transaction = f.calls.find(call => call.query.includes('BEGIN TRANSACTION'));
    assert.match(transaction.query, /UPDATE `test-project.test_data.administration_task_registry_state`/);
    assert.match(transaction.query, /revision>=0/);
    assert.ok(transaction.query.indexOf('administration_task_registry_state') < transaction.query.indexOf('UPDATE `test-project.test_data.administration_correspondence`'));
    const other = fixture();
    assert.equal((await other.call(method, 'COR-unrelated')).statusCode, 200);
    assert.doesNotMatch(other.calls.find(call => call.query.includes('BEGIN TRANSACTION')).query, /administration_task_registry_state/);
    const disabled = fixture({ coordinated: false });
    assert.equal((await disabled.call(method)).statusCode, 200);
    assert.doesNotMatch(disabled.calls.find(call => call.query.includes('BEGIN TRANSACTION')).query, /administration_task_registry_state/);
  }
});

test('both configured source and consultation are fenced while unrelated correspondence remains unchanged', async () => {
  for (const method of ['updateCorrespondence', 'deleteCorrespondence']) {
    const f = fixture({ coordinatedIds: ['COR-fixture-consultation'] });
    assert.equal((await f.call(method, 'COR-fixture-consultation')).statusCode, 200);
    assert.match(f.calls.find(call => call.query.includes('BEGIN TRANSACTION')).query, /administration_task_registry_state/);
    const frozen = fixture({ coordinatedIds: ['COR-fixture-consultation'], failFence: true });
    assert.equal((await frozen.call(method, 'COR-fixture-consultation')).statusCode, 503);
    const unrelated = fixture({ coordinatedIds: ['COR-fixture-consultation'] });
    assert.equal((await unrelated.call(method, 'COR-unrelated')).statusCode, 200);
    assert.doesNotMatch(unrelated.calls.find(call => call.query.includes('BEGIN TRANSACTION')).query, /administration_task_registry_state/);
  }
});

test('invalid coordinated correspondence configuration fails closed at construction', () => {
  for (const coordinatedIds of [null, 'COR-test', [''], [' COR-test'], [42], Array(17).fill('COR-test')]) {
    assert.throws(() => fixture({ coordinatedIds }), /ADMIN_REGISTRY_COORDINATION_INVALID/);
  }
});

test('a frozen task fence rejects the correspondence change without granting any extra permission', async () => {
  const f = fixture({ failFence: true });
  const res = await f.call('updateCorrespondence');
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'ADMIN_REGISTRY_COORDINATION_UNAVAILABLE');
  const f2 = fixture({ failFence: true });
  assert.equal((await f2.call('deleteCorrespondence')).statusCode, 503);
});

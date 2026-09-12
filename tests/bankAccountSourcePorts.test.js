'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BankAccountSourceError,
  CONTRACT_VERSION,
  DATA_CLASSIFICATION,
  ENVIRONMENT_CLASS,
  MAX_CANDIDATE_HANDLES,
  MAX_SOURCE_RECORDS,
  SOURCE_CAPABILITIES,
  createMaskedBankAccountSourcePorts
} = require('../bankAccountSourcePorts');
const { createBankAccountReferencePolicyService } = require('../bankAccountReferences');
const { createBankAccountReadService } = require('../bankAccountReads');
const { createFakeAuthenticatedCursorCodec } = require('./helpers/fakeAuthenticatedCursorCodec');
const { createFakeMaskedBankAccountSource } = require('./helpers/fakeMaskedBankAccountSource');

const TENANT_ID = 'tenant-fictional';
const ACTOR_ID = 'actor-fictional';
const REQUEST_AT = '2026-09-12T12:30:00Z';
const LIST_REVISION = 'list-rev-fictional-1';

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function holderSnapshot() {
  return {
    id: 'entity-fictional',
    labelSnapshot: 'Organisation fictive',
    sourceRevision: 'entity-rev-fictional-1'
  };
}

function institutionSnapshot() {
  return {
    id: 'institution-fictional',
    labelSnapshot: 'Institution fictive',
    countryId: 'CH',
    institutionType: 'bank',
    sourceRevision: 'institution-rev-fictional-1'
  };
}

function ownerSnapshot() {
  return {
    id: 'agent-fictional',
    labelSnapshot: 'Agent fictif',
    sourceRevision: 'agent-rev-fictional-1'
  };
}

function summary(index = 1, overrides = {}) {
  return {
    bankAccountId: uuid(index),
    tenantId: TENANT_ID,
    holderEntity: holderSnapshot(),
    financialInstitution: institutionSnapshot(),
    internalLabel: `Compte fictif ${String(index).padStart(3, '0')}`,
    accountType: 'OPERATING_CURRENT',
    currency: 'CHF',
    status: 'active',
    maskedIdentifier: `********${String(index).padStart(4, '0')}`,
    classification: 'C2',
    businessOwnerAgent: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    sourceRevision: `account-rev-fictional-${index}`,
    verifiedAt: '2026-09-12T12:00:00Z',
    recordVersion: 1,
    ...overrides
  };
}

function accountRecord(account = summary(), overrides = {}) {
  return { summary: account, visible: true, ...overrides };
}

function relation(snapshot, overrides = {}) {
  return {
    id: snapshot.id,
    tenantId: TENANT_ID,
    labelSnapshot: snapshot.labelSnapshot,
    sourceRevision: snapshot.sourceRevision,
    active: true,
    visible: true,
    classification: 'C2',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    ...overrides
  };
}

function institutionRelation(overrides = {}) {
  return {
    ...relation(institutionSnapshot()),
    countryId: 'CH',
    institutionType: 'bank',
    ...overrides
  };
}

function handle(account = summary()) {
  return {
    bankAccountId: account.bankAccountId,
    internalLabelOrder: account.internalLabel,
    sourceRevision: account.sourceRevision
  };
}

function accountQuery(overrides = {}) {
  return {
    bankAccountId: uuid(1),
    tenantId: TENANT_ID,
    operation: 'READ',
    requestAt: REQUEST_AT,
    ...overrides
  };
}

function relationQuery(snapshot = holderSnapshot(), overrides = {}) {
  return {
    id: snapshot.id,
    tenantId: TENANT_ID,
    operation: 'READ',
    requestAt: REQUEST_AT,
    sourceRevision: snapshot.sourceRevision,
    ...overrides
  };
}

function listQuery(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    operation: 'READ',
    requestAt: REQUEST_AT,
    filters: {},
    after: null,
    candidateLimit: 26,
    signal: new AbortController().signal,
    ...overrides
  };
}

function readContext(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    operation: 'READ',
    requestAt: REQUEST_AT,
    permissions: ['finance:read'],
    capabilities: ['bank-account:read-masked'],
    ...overrides
  };
}

function fakeOptions(overrides = {}) {
  const account = overrides.accountValue || summary();
  const fake = createFakeMaskedBankAccountSource({
    accounts: [accountRecord(account)],
    entities: [relation(account.holderEntity)],
    institutions: [institutionRelation()],
    agents: account.businessOwnerAgent ? [relation(account.businessOwnerAgent)] : [],
    handles: [handle(account)],
    totalCount: 1,
    ...overrides
  });
  return fake;
}

function setup(overrides = {}) {
  const fake = fakeOptions(overrides);
  return {
    fake,
    ports: createMaskedBankAccountSourcePorts(fake.options)
  };
}

function expectSourceCode(code) {
  return error => error instanceof BankAccountSourceError
    && error.code === code
    && error.message === 'Bank account source request could not be completed';
}

test('1 - factory validates one fictional contract probe and returns five frozen ports', () => {
  const candidate = setup();
  assert.deepEqual(Object.keys(candidate.ports), [
    'resolveAccount', 'resolveEntity', 'resolveInstitution', 'resolveAgent',
    'listAccountHandles'
  ]);
  assert.equal(Object.isFrozen(candidate.ports), true);
  assert.equal(candidate.fake.calls.probe.length, 1);
  assert.equal(CONTRACT_VERSION, 'M3S-CB-1-D-A-001-V0.1');
  assert.equal(DATA_CLASSIFICATION, 'MASKED_ORGANIZATIONAL_METADATA_ONLY');
  assert.equal(ENVIRONMENT_CLASS, 'FICTIONAL_TEST_DOUBLE');
  assert.equal(MAX_SOURCE_RECORDS, 2);
  assert.equal(MAX_CANDIDATE_HANDLES, 51);
  assert.equal(Object.isFrozen(SOURCE_CAPABILITIES), true);
});

test('2 - factory rejects missing, extra, inherited, accessor and proxied dependencies', () => {
  const baseline = fakeOptions().options;
  const accessor = { ...baseline };
  Object.defineProperty(accessor, 'accountSource', {
    enumerable: true,
    get() { throw new Error('must not execute'); }
  });
  const revoked = Proxy.revocable({ ...baseline }, {});
  revoked.revoke();
  for (const candidate of [
    {},
    { ...baseline, unknown: true },
    Object.create(baseline),
    accessor,
    new Proxy({ ...baseline }, {}),
    revoked.proxy
  ]) {
    assert.throws(
      () => createMaskedBankAccountSourcePorts(candidate),
      expectSourceCode('BANK_ACCOUNT_SOURCE_REQUEST_INVALID')
    );
  }
});

test('3 - relation source collection is exact and contains three functions', () => {
  const baseline = fakeOptions().options;
  for (const relationSources of [
    {},
    { ...baseline.relationSources, unknown: async () => {} },
    { ...baseline.relationSources, agent: null },
    new Proxy({ ...baseline.relationSources }, {})
  ]) {
    assert.throws(
      () => createMaskedBankAccountSourcePorts({ ...baseline, relationSources }),
      expectSourceCode('BANK_ACCOUNT_SOURCE_REQUEST_INVALID')
    );
  }
});

test('4 - probe requires the exact fictional attestation and all capabilities', () => {
  const valid = fakeOptions().options;
  const baseProbe = valid.sourceProbe();
  const candidates = [
    { ...baseProbe, contractVersion: 'V2' },
    { ...baseProbe, environmentClass: 'PRODUCTION' },
    { ...baseProbe, dataClassification: 'FULL_BANK_DATA' },
    { ...baseProbe, capabilities: SOURCE_CAPABILITIES.slice(0, -1) },
    { ...baseProbe, capabilities: [...SOURCE_CAPABILITIES, 'EXTRA'] },
    { ...baseProbe, unknown: true },
    Promise.resolve(baseProbe)
  ];
  for (const probeResult of candidates) {
    const fake = fakeOptions({ probeResult });
    assert.throws(
      () => createMaskedBankAccountSourcePorts(fake.options),
      expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
    );
  }
});

test('5 - probe errors are sanitized and never preserve private diagnostics', () => {
  const fake = fakeOptions({ probeThrows: true });
  assert.throws(
    () => createMaskedBankAccountSourcePorts(fake.options),
    error => expectSourceCode('BANK_ACCOUNT_SOURCE_UNAVAILABLE')(error)
      && !error.message.includes('Fictional')
  );
});

test('6 - an unavailable probe closes every port without consulting a source', async () => {
  const candidate = setup({ probeAvailable: false });
  assert.deepEqual(await candidate.ports.resolveAccount(accountQuery()), {
    available: false, records: []
  });
  assert.deepEqual(await candidate.ports.listAccountHandles(listQuery()), {
    available: false,
    listRevision: 'source-unavailable',
    records: [],
    hasMore: false,
    provenTotal: null
  });
  assert.equal(candidate.fake.calls.account.length, 0);
  assert.equal(candidate.fake.calls.list.length, 0);
  assert.equal(candidate.fake.calls.total.length, 0);
});

test('7 - exact account resolution receives one detached frozen query', async () => {
  const candidate = setup();
  const result = await candidate.ports.resolveAccount(accountQuery());
  assert.equal(candidate.fake.calls.account.length, 1);
  assert.equal(Object.isFrozen(candidate.fake.calls.account[0]), true);
  assert.notEqual(candidate.fake.calls.account[0], accountQuery());
  assert.equal(result.records.length, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.records), true);
  assert.equal(Object.isFrozen(result.records[0].summary), true);
});

test('8 - account lookup does not accept labels, masks or fallback fields', async () => {
  const candidate = setup();
  for (const request of [
    { ...accountQuery(), internalLabel: 'Compte fictif' },
    { ...accountQuery(), maskedIdentifier: '********0001' },
    { ...accountQuery(), bankAccountId: 'account-fictional' },
    { ...accountQuery(), tenantId: 'tenant with spaces' },
    { ...accountQuery(), operation: 'WRITE' }
  ]) {
    await assert.rejects(
      candidate.ports.resolveAccount(request),
      expectSourceCode('BANK_ACCOUNT_SOURCE_REQUEST_INVALID')
    );
  }
  assert.equal(candidate.fake.calls.account.length, 0);
});

test('9 - hostile account query shapes are rejected before the source', async () => {
  const accessor = accountQuery();
  Object.defineProperty(accessor, 'tenantId', {
    enumerable: true,
    get() { throw new Error('must not execute'); }
  });
  const symbol = accountQuery();
  symbol[Symbol('hidden')] = true;
  const revoked = Proxy.revocable(accountQuery(), {});
  revoked.revoke();
  const candidate = setup();
  for (const request of [
    Object.create(accountQuery()),
    accessor,
    symbol,
    new Proxy(accountQuery(), {}),
    revoked.proxy
  ]) {
    await assert.rejects(
      candidate.ports.resolveAccount(request),
      expectSourceCode('BANK_ACCOUNT_SOURCE_REQUEST_INVALID')
    );
  }
  assert.equal(candidate.fake.calls.account.length, 0);
});

test('10 - account cardinalities zero, one and two stay bounded and explicit', async () => {
  for (const count of [0, 1, 2]) {
    const records = Array.from({ length: count }, () => accountRecord());
    const candidate = setup({ account: { result: { available: true, records } } });
    const result = await candidate.ports.resolveAccount(accountQuery());
    assert.equal(result.records.length, count);
  }
  const candidate = setup({
    account: { result: { available: true, records: [accountRecord(), accountRecord(), accountRecord()] } }
  });
  await assert.rejects(
    candidate.ports.resolveAccount(accountQuery()),
    expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
  );
});

test('11 - unavailable resolution requires an empty exact envelope', async () => {
  const unavailable = setup({ account: { available: false } });
  assert.deepEqual(await unavailable.ports.resolveAccount(accountQuery()), {
    available: false, records: []
  });
  for (const result of [
    { available: false, records: [accountRecord()] },
    { available: false, records: [], reason: 'private' },
    { available: 'false', records: [] }
  ]) {
    const candidate = setup({ account: { result } });
    await assert.rejects(
      candidate.ports.resolveAccount(accountQuery()),
      expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
    );
  }
});

test('12 - account payloads remain the exact masked CB-1-A projection', async () => {
  for (const mutate of [
    value => { value.summary.balance = '1000'; },
    value => { value.summary.maskedIdentifier = 'CH001234567890'; },
    value => { value.visible = 'yes'; },
    value => { value.raw = 'private'; }
  ]) {
    const record = accountRecord();
    mutate(record);
    const candidate = setup({ account: { result: { available: true, records: [record] } } });
    await assert.rejects(
      candidate.ports.resolveAccount(accountQuery()),
      expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
    );
  }
});

test('13 - source failures are sanitized as unavailable', async () => {
  const candidate = setup({ account: { throwError: true } });
  await assert.rejects(
    candidate.ports.resolveAccount(accountQuery()),
    error => expectSourceCode('BANK_ACCOUNT_SOURCE_UNAVAILABLE')(error)
      && !error.message.includes('Fictional')
  );
});

test('14 - entity, institution and agent ports preserve exact revision queries', async () => {
  const account = summary(1, { businessOwnerAgent: ownerSnapshot() });
  const candidate = setup({ accountValue: account });
  const cases = [
    ['resolveEntity', account.holderEntity, 'entity'],
    ['resolveInstitution', account.financialInstitution, 'institution'],
    ['resolveAgent', account.businessOwnerAgent, 'agent']
  ];
  for (const [method, snapshot, kind] of cases) {
    const result = await candidate.ports[method](relationQuery(snapshot));
    assert.equal(result.records.length, 1);
    assert.equal(candidate.fake.calls[kind].length, 1);
    assert.equal(Object.isFrozen(candidate.fake.calls[kind][0]), true);
    assert.equal(result.records[0].sourceRevision, snapshot.sourceRevision);
  }
});

test('15 - relation queries require an exact id, tenant, instant and revision', async () => {
  const candidate = setup();
  for (const request of [
    { ...relationQuery(), sourceRevision: '' },
    { ...relationQuery(), id: '../entity' },
    { ...relationQuery(), tenantId: 'tenant other' },
    { ...relationQuery(), requestAt: '2026-09-12' },
    { ...relationQuery(), operation: 'WRITE' },
    { ...relationQuery(), label: 'Organisation fictive' }
  ]) {
    await assert.rejects(
      candidate.ports.resolveEntity(request),
      expectSourceCode('BANK_ACCOUNT_SOURCE_REQUEST_INVALID')
    );
  }
  assert.equal(candidate.fake.calls.entity.length, 0);
});

test('16 - relation records are closed, bounded and temporally coherent', async () => {
  const cases = [
    relation(holderSnapshot(), { active: 'true' }),
    relation(holderSnapshot(), { classification: 'C1' }),
    relation(holderSnapshot(), { effectiveFrom: '2026-13-01' }),
    relation(holderSnapshot(), { effectiveFrom: '2026-12-31', effectiveTo: '2026-01-01' }),
    { ...relation(holderSnapshot()), unknown: true }
  ];
  for (const record of cases) {
    const candidate = setup({ entity: { result: { available: true, records: [record] } } });
    await assert.rejects(
      candidate.ports.resolveEntity(relationQuery()),
      expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
    );
  }
});

test('17 - institution records require country and regulated institution type', async () => {
  for (const record of [
    relation(institutionSnapshot()),
    institutionRelation({ institutionType: 'wallet' }),
    institutionRelation({ countryId: 'C H' }),
    { ...institutionRelation(), bic: 'HIDDEN' }
  ]) {
    const candidate = setup({ institution: { result: { available: true, records: [record] } } });
    await assert.rejects(
      candidate.ports.resolveInstitution(relationQuery(institutionSnapshot())),
      expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
    );
  }
});

test('18 - list query is exact with frozen filters and continuation state', async () => {
  const candidate = setup();
  const result = await candidate.ports.listAccountHandles(listQuery({
    filters: { currency: 'CHF', classification: 'C2' }
  }));
  assert.equal(candidate.fake.calls.list.length, 1);
  const received = candidate.fake.calls.list[0].query;
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received.filters), true);
  assert.equal(result.records.length, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.records), true);
});

test('19 - only the six closed filters and their enumerations are accepted', async () => {
  const accepted = {
    holderEntityId: 'entity-fictional',
    financialInstitutionId: 'institution-fictional',
    accountType: 'OPERATING_CURRENT',
    currency: 'CHF',
    status: 'active',
    classification: 'C2'
  };
  await setup().ports.listAccountHandles(listQuery({ filters: accepted }));
  for (const filters of [
    { search: 'bank' },
    { currency: ['CHF'] },
    { currency: 'CFA' },
    { accountType: 'WALLET' },
    { status: 'approved' },
    { classification: 'PUBLIC' },
    new Proxy({ currency: 'CHF' }, {})
  ]) {
    const candidate = setup();
    await assert.rejects(
      candidate.ports.listAccountHandles(listQuery({ filters })),
      expectSourceCode('BANK_ACCOUNT_SOURCE_REQUEST_INVALID')
    );
    assert.equal(candidate.fake.calls.list.length, 0);
  }
});

test('20 - candidate limits are integers from 2 through 51', async () => {
  for (const limit of [2, 26, 51]) {
    const candidate = setup();
    await candidate.ports.listAccountHandles(listQuery({ candidateLimit: limit }));
    assert.equal(candidate.fake.calls.list[0].snapshot.candidateLimit, limit);
  }
  for (const candidateLimit of [1, 52, '26', 2.5, null]) {
    const candidate = setup();
    await assert.rejects(
      candidate.ports.listAccountHandles(listQuery({ candidateLimit })),
      expectSourceCode('BANK_ACCOUNT_SOURCE_REQUEST_INVALID')
    );
  }
});

test('21 - continuation handles are exact, revision-bound and strictly advanced', async () => {
  const first = summary(1);
  const second = summary(2);
  const after = {
    internalLabelOrder: first.internalLabel,
    bankAccountId: first.bankAccountId,
    listRevision: LIST_REVISION
  };
  const candidate = setup({
    accountValue: second,
    handles: [handle(first), handle(second)]
  });
  const result = await candidate.ports.listAccountHandles(listQuery({ after }));
  assert.equal(result.records[0].bankAccountId, second.bankAccountId);
  assert.equal(Object.isFrozen(candidate.fake.calls.list[0].query.after), true);

  for (const invalidAfter of [
    { ...after, listRevision: 'other-revision' },
    { ...after, unknown: true },
    { ...after, bankAccountId: 'not-a-uuid' }
  ]) {
    const current = setup({ handles: [handle(second)] });
    await assert.rejects(
      current.ports.listAccountHandles(listQuery({ after: invalidAfter })),
      error => ['BANK_ACCOUNT_SOURCE_REQUEST_INVALID', 'BANK_ACCOUNT_SOURCE_INVALID']
        .includes(error.code)
    );
  }
});

test('22 - list output accepts at most 51 exact unique and sorted handles', async () => {
  const accounts = Array.from({ length: 51 }, (_, index) => summary(index + 1));
  const candidate = setup({
    accountValue: accounts[0],
    handles: accounts.map(handle),
    totalCount: 51
  });
  const result = await candidate.ports.listAccountHandles(listQuery({ candidateLimit: 51 }));
  assert.equal(result.records.length, 51);
  assert.equal(result.hasMore, true);
  assert.equal(result.records[50].bankAccountId, uuid(51));

  const tooMany = setup({
    list: {
      result: {
        available: true,
        listRevision: LIST_REVISION,
        records: Array.from({ length: 52 }, (_, index) => handle(summary(index + 1))),
        hasMore: true
      }
    }
  });
  await assert.rejects(
    tooMany.ports.listAccountHandles(listQuery({ candidateLimit: 51 })),
    expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
  );
});

test('23 - duplicate, reversed and open handles are refused without correction', async () => {
  const first = handle(summary(1));
  const second = handle(summary(2));
  for (const records of [
    [first, first],
    [second, first],
    [{ ...first, rawIdentifier: 'hidden' }]
  ]) {
    const candidate = setup({
      list: { result: { available: true, listRevision: LIST_REVISION, records, hasMore: false } }
    });
    await assert.rejects(
      candidate.ports.listAccountHandles(listQuery()),
      expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
    );
  }
});

test('24 - Unicode labels use code-point order and ids break ties deterministically', async () => {
  const first = handle(summary(1, { internalLabel: '\uE000' }));
  const second = handle(summary(2, { internalLabel: '\u{10000}' }));
  const tied = handle(summary(3, { internalLabel: '\u{10000}' }));
  const candidate = setup({
    handles: [first, second, tied],
    totalCount: 3
  });
  const result = await candidate.ports.listAccountHandles(listQuery());
  assert.deepEqual(result.records.map(item => item.bankAccountId), [uuid(1), uuid(2), uuid(3)]);
});

test('25 - hasMore must match the limit-plus-one cardinality', async () => {
  const one = handle(summary());
  for (const result of [
    { available: true, listRevision: LIST_REVISION, records: [one], hasMore: true },
    { available: true, listRevision: LIST_REVISION, records: [one, handle(summary(2))], hasMore: false }
  ]) {
    const candidate = setup({ list: { result } });
    await assert.rejects(
      candidate.ports.listAccountHandles(listQuery({ candidateLimit: 2 })),
      expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
    );
  }
});

test('26 - unavailable list is closed and never requests a total', async () => {
  const candidate = setup({ list: { available: false } });
  assert.deepEqual(await candidate.ports.listAccountHandles(listQuery()), {
    available: false,
    listRevision: 'source-unavailable',
    records: [],
    hasMore: false,
    provenTotal: null
  });
  assert.equal(candidate.fake.calls.total.length, 0);
});

test('27 - malformed unavailable list envelopes are rejected', async () => {
  for (const result of [
    { available: false, listRevision: 'private-rev', records: [], hasMore: false },
    { available: false, listRevision: null, records: [handle()], hasMore: false },
    { available: false, listRevision: null, records: [], hasMore: true },
    { available: false, listRevision: null, records: [], hasMore: false, reason: 'private' }
  ]) {
    const candidate = setup({ list: { result } });
    await assert.rejects(
      candidate.ports.listAccountHandles(listQuery()),
      expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
    );
  }
});

test('28 - total proof is bound to tenant, actor, filters and list revision', async () => {
  const filters = { currency: 'CHF' };
  const candidate = setup({ totalCount: 1 });
  const result = await candidate.ports.listAccountHandles(listQuery({ filters }));
  assert.deepEqual(result.provenTotal, {
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    filters,
    listRevision: LIST_REVISION,
    sourceRevision: 'source-rev-fictional-1',
    scope: 'authorized_filtered',
    count: 1
  });
  assert.equal(Object.isFrozen(result.provenTotal), true);
  assert.equal(Object.isFrozen(result.provenTotal.filters), true);
  assert.equal(Object.isFrozen(candidate.fake.calls.total[0]), true);
});

test('29 - zero is proven while absent, unavailable and failed totals remain null', async () => {
  const zero = setup({ totalCount: 0 });
  assert.equal((await zero.ports.listAccountHandles(listQuery())).provenTotal.count, 0);
  for (const options of [
    { totalCount: undefined },
    { total: { available: false } },
    { total: { throwError: true } }
  ]) {
    const candidate = setup(options);
    const result = await candidate.ports.listAccountHandles(listQuery());
    assert.equal(result.provenTotal, null);
  }
});

test('30 - contradictory, raw or malformed totals are downgraded to unavailable', async () => {
  const valid = {
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    filters: {},
    listRevision: LIST_REVISION,
    sourceRevision: 'source-rev-fictional-1',
    scope: 'authorized_filtered',
    count: 1
  };
  for (const provenTotal of [
    { ...valid, tenantId: 'other-tenant' },
    { ...valid, actorId: 'other-actor' },
    { ...valid, listRevision: 'other-revision' },
    { ...valid, scope: 'raw_all_accounts' },
    { ...valid, count: -1 },
    { ...valid, raw: 'private' }
  ]) {
    const candidate = setup({ total: { result: { available: true, provenTotal } } });
    const result = await candidate.ports.listAccountHandles(listQuery());
    assert.equal(result.provenTotal, null);
  }
});

test('31 - list failures and pre-aborted requests fail closed with generic errors', async () => {
  const failed = setup({ list: { throwError: true } });
  await assert.rejects(
    failed.ports.listAccountHandles(listQuery()),
    expectSourceCode('BANK_ACCOUNT_SOURCE_UNAVAILABLE')
  );
  const controller = new AbortController();
  controller.abort();
  const aborted = setup();
  await assert.rejects(
    aborted.ports.listAccountHandles(listQuery({ signal: controller.signal })),
    expectSourceCode('BANK_ACCOUNT_SOURCE_UNAVAILABLE')
  );
  assert.equal(aborted.fake.calls.list.length, 0);
});

test('31b - fake, proxied and accessor signals are rejected without evaluating getters', async () => {
  let getterReads = 0;
  const accessorSignal = {
    get aborted() {
      getterReads += 1;
      return false;
    },
    addEventListener() {}
  };
  const shadowedSignal = new AbortController().signal;
  Object.defineProperty(shadowedSignal, 'aborted', {
    configurable: true,
    get() {
      getterReads += 1;
      return false;
    }
  });
  const forgedSignal = Object.create(AbortSignal.prototype);
  const realSignal = new AbortController().signal;
  const revokedSignal = Proxy.revocable(realSignal, {});
  revokedSignal.revoke();
  for (const signal of [
    accessorSignal,
    shadowedSignal,
    forgedSignal,
    new Proxy(realSignal, {}),
    revokedSignal.proxy
  ]) {
    const candidate = setup();
    await assert.rejects(
      candidate.ports.listAccountHandles(listQuery({ signal })),
      expectSourceCode('BANK_ACCOUNT_SOURCE_REQUEST_INVALID')
    );
    assert.equal(candidate.fake.calls.list.length, 0);
  }
  assert.equal(getterReads, 0);
});

test('31c - fictional pagination resumes with the same Unicode code-point order', async () => {
  const first = summary(1, { internalLabel: '\uE000' });
  const second = summary(2, { internalLabel: '\u{10000}' });
  const candidate = setup({ handles: [first, second].map(handle), totalCount: 2 });
  const result = await candidate.ports.listAccountHandles(listQuery({
    after: {
      internalLabelOrder: first.internalLabel,
      bankAccountId: first.bankAccountId,
      listRevision: LIST_REVISION
    }
  }));
  assert.deepEqual(result.records.map(item => item.bankAccountId), [second.bankAccountId]);
});

test('32 - hostile resolver and list arrays fail without raw proxy errors', async () => {
  const revokedRecords = Proxy.revocable([], {});
  revokedRecords.revoke();
  const accountCandidate = setup({
    account: { result: { available: true, records: revokedRecords.proxy } }
  });
  await assert.rejects(
    accountCandidate.ports.resolveAccount(accountQuery()),
    expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
  );

  const revokedList = Proxy.revocable([], {});
  revokedList.revoke();
  const listCandidate = setup({
    list: {
      result: {
        available: true,
        listRevision: LIST_REVISION,
        records: revokedList.proxy,
        hasMore: false
      }
    }
  });
  await assert.rejects(
    listCandidate.ports.listAccountHandles(listQuery()),
    expectSourceCode('BANK_ACCOUNT_SOURCE_INVALID')
  );
});

test('33 - source mutation attempts cannot alter account, list or total queries', async () => {
  const candidate = setup({
    account: { mutateQuery: query => { query.tenantId = 'changed'; } },
    list: { mutateQuery: query => { query.filters.currency = 'EUR'; } },
    total: { mutateQuery: query => { query.listRevision = 'changed'; } }
  });
  await assert.rejects(
    candidate.ports.resolveAccount(accountQuery()),
    expectSourceCode('BANK_ACCOUNT_SOURCE_UNAVAILABLE')
  );
  await assert.rejects(
    candidate.ports.listAccountHandles(listQuery({ filters: { currency: 'CHF' } })),
    expectSourceCode('BANK_ACCOUNT_SOURCE_UNAVAILABLE')
  );

  const totalMutation = setup({
    total: { mutateQuery: query => { query.listRevision = 'changed'; } }
  });
  const result = await totalMutation.ports.listAccountHandles(listQuery());
  assert.equal(result.provenTotal, null);
});

test('34 - CB-1-B consumes the ports while keeping policy and relation authority', async () => {
  const candidate = setup();
  const service = createBankAccountReferencePolicyService({
    accountResolver: candidate.ports.resolveAccount,
    entityResolver: candidate.ports.resolveEntity,
    institutionResolver: candidate.ports.resolveInstitution,
    agentResolver: candidate.ports.resolveAgent,
    canReadRestricted: async () => false
  });
  const result = await service.resolveReadableBankAccountSummary({
    bankAccountId: uuid(1),
    context: readContext()
  });
  assert.equal(result.bankAccountId, uuid(1));
  assert.equal(result.maskedIdentifier, '********0001');
});

test('35 - the source cannot bypass CB-1-B C3 authorization', async () => {
  const restricted = summary(1, { classification: 'C3' });
  const candidate = setup({ accountValue: restricted });
  const service = createBankAccountReferencePolicyService({
    accountResolver: candidate.ports.resolveAccount,
    entityResolver: candidate.ports.resolveEntity,
    institutionResolver: candidate.ports.resolveInstitution,
    agentResolver: candidate.ports.resolveAgent,
    canReadRestricted: async () => false
  });
  await assert.rejects(
    service.resolveReadableBankAccountSummary({
      bankAccountId: restricted.bankAccountId,
      context: readContext()
    }),
    error => error.code === 'BANK_ACCOUNT_ACCESS_DENIED'
  );
});

test('36 - CB-1-C consumes source handles and preserves versioned proven totals', async () => {
  const candidate = setup();
  const referenceService = createBankAccountReferencePolicyService({
    accountResolver: candidate.ports.resolveAccount,
    entityResolver: candidate.ports.resolveEntity,
    institutionResolver: candidate.ports.resolveInstitution,
    agentResolver: candidate.ports.resolveAgent,
    canReadRestricted: async () => false
  });
  const service = createBankAccountReadService({
    referencePolicyService: referenceService,
    listResolver: candidate.ports.listAccountHandles,
    cursorCodec: createFakeAuthenticatedCursorCodec().codec
  });
  const page = await service.listBankAccountSummaries({
    context: readContext(),
    filters: {},
    cursor: null,
    limit: 25
  });
  assert.equal(page.pageCount, 1);
  assert.equal(page.totalCount, 1);
  assert.equal(page.totalStatus, 'proven');
  assert.equal(page.listRevision, LIST_REVISION);
});

test('37 - pure ports contain no route, SDK, environment, file, SQL or network dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bankAccountSourcePorts.js'), 'utf8');
  for (const forbidden of [
    /\bexpress\b/i,
    /@google-cloud/i,
    /process\.env/,
    /\bfetch\s*\(/i,
    /\bhttps?\b/i,
    /\bfs\./i,
    /CREATE\s+TABLE/i,
    /ALTER\s+TABLE/i,
    /DROP\s+TABLE/i,
    /require\(['"](?:pg|mysql|sqlite|@electric-sql)/i
  ]) assert.doesNotMatch(source, forbidden);
});

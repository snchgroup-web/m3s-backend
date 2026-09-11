'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BankAccountReferenceError,
  MAX_RESOLVER_CALLS,
  createBankAccountReferencePolicyService
} = require('../bankAccountReferences');
const { createFakeBankAccountResolver } = require('./helpers/fakeBankAccountResolver');

const ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_AT = '2026-09-11T18:00:00Z';

function snapshot(id, label, revision) {
  return { id, labelSnapshot: label, sourceRevision: revision };
}

function institutionSnapshot() {
  return {
    ...snapshot('institution-fictional', 'Etablissement fictif', 'institution-rev-1'),
    countryId: 'CH',
    institutionType: 'bank'
  };
}

function summary(overrides = {}) {
  return {
    bankAccountId: ACCOUNT_ID,
    tenantId: 'tenant-fictional',
    holderEntity: snapshot('entity-fictional', 'Organisation fictive', 'entity-rev-1'),
    financialInstitution: institutionSnapshot(),
    internalLabel: 'Compte fictif masque',
    accountType: 'OPERATING_CURRENT',
    currency: 'CHF',
    status: 'active',
    maskedIdentifier: '********1234',
    classification: 'C2',
    businessOwnerAgent: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    sourceRevision: 'account-rev-1',
    verifiedAt: '2026-09-11T17:00:00Z',
    recordVersion: 1,
    ...overrides
  };
}

function relation(reference, overrides = {}) {
  return {
    id: reference.id,
    tenantId: 'tenant-fictional',
    labelSnapshot: reference.labelSnapshot,
    sourceRevision: reference.sourceRevision,
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

function context(overrides = {}) {
  return {
    tenantId: 'tenant-fictional',
    actorId: 'agent-reader-fictional',
    operation: 'READ',
    requestAt: REQUEST_AT,
    permissions: ['finance:read'],
    capabilities: ['bank-account:read-masked'],
    ...overrides
  };
}

function createSetup(overrides = {}) {
  const account = overrides.summary || summary();
  const accountResolver = overrides.accountResolver || createFakeBankAccountResolver([
    { summary: account, visible: overrides.accountVisible ?? true }
  ]);
  const entityResolver = overrides.entityResolver || createFakeBankAccountResolver([
    relation(account.holderEntity)
  ]);
  const institutionResolver = overrides.institutionResolver || createFakeBankAccountResolver([
    institutionRelation()
  ]);
  const agentResolver = overrides.agentResolver || createFakeBankAccountResolver(
    account.businessOwnerAgent ? [relation(account.businessOwnerAgent)] : []
  );
  const policyCalls = [];
  const canReadRestricted = Object.hasOwn(overrides, 'canReadRestricted')
    ? overrides.canReadRestricted
    : async query => { policyCalls.push(structuredClone(query)); return true; };
  const service = createBankAccountReferencePolicyService({
    accountResolver,
    entityResolver,
    institutionResolver,
    agentResolver,
    canReadRestricted
  });
  return {
    service,
    accountResolver,
    entityResolver,
    institutionResolver,
    agentResolver,
    policyCalls
  };
}

function expectCode(code) {
  return error => error instanceof BankAccountReferenceError
    && error.code === code
    && error.message === 'Bank account request could not be completed';
}

async function resolve(setup, contextOverride = {}) {
  return setup.service.resolveReadableBankAccountSummary({
    bankAccountId: ACCOUNT_ID,
    context: context(contextOverride)
  });
}

test('valid READ context resolves a minimal deeply frozen C2 summary', async () => {
  const setup = createSetup();
  const result = await resolve(setup);
  assert.equal(result.bankAccountId, ACCOUNT_ID);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.holderEntity), true);
  assert.equal(Object.isFrozen(result.financialInstitution), true);
  assert.equal(setup.accountResolver.calls.length, 1);
  assert.equal(setup.entityResolver.calls.length, 1);
  assert.equal(setup.institutionResolver.calls.length, 1);
  assert.equal(setup.agentResolver.calls.length, 0);
  assert.equal(setup.policyCalls.length, 0);
});

test('request and context reject unknown, accessor, proxy, symbol and inherited fields', async () => {
  const setup = createSetup();
  const candidates = [];
  candidates.push({ bankAccountId: ACCOUNT_ID, context: context(), unknown: true });
  const withSymbol = context(); withSymbol[Symbol('hidden')] = true;
  candidates.push({ bankAccountId: ACCOUNT_ID, context: withSymbol });
  candidates.push({ bankAccountId: ACCOUNT_ID, context: Object.create(context()) });
  const accessor = context();
  Object.defineProperty(accessor, 'actorId', { enumerable: true, get: () => 'attacker' });
  candidates.push({ bankAccountId: ACCOUNT_ID, context: accessor });
  const proxy = new Proxy(context(), {});
  candidates.push({ bankAccountId: ACCOUNT_ID, context: proxy });
  for (const candidate of candidates) {
    await assert.rejects(
      setup.service.resolveReadableBankAccountSummary(candidate),
      expectCode('BANK_ACCOUNT_REQUEST_INVALID')
    );
  }
  assert.equal(setup.accountResolver.calls.length, 0);
});

test('missing permission is denied before any resolver call', async () => {
  const setup = createSetup();
  await assert.rejects(resolve(setup, { permissions: [] }), expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
  assert.equal(setup.accountResolver.calls.length, 0);
});

test('missing capability is denied before any resolver call', async () => {
  const setup = createSetup();
  await assert.rejects(resolve(setup, { capabilities: [] }), expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
  assert.equal(setup.accountResolver.calls.length, 0);
});

test('unavailable and failing account sources use one generic unavailable error', async () => {
  for (const options of [{ available: false }, { throwError: true }]) {
    const accountResolver = createFakeBankAccountResolver([], options);
    const setup = createSetup({ accountResolver });
    await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_REFERENCE_UNAVAILABLE'));
    assert.equal(accountResolver.calls.length, 1);
    assert.equal(setup.entityResolver.calls.length, 0);
  }
});

test('malformed resolver envelopes and multiple accounts are invalid', async () => {
  const malformed = async () => ({ available: true, records: [], extra: true });
  await assert.rejects(resolve(createSetup({ accountResolver: malformed })),
    expectCode('BANK_ACCOUNT_REFERENCE_INVALID'));

  const candidate = { summary: summary(), visible: true };
  const multiple = createFakeBankAccountResolver([candidate, candidate], { returnAll: true });
  await assert.rejects(resolve(createSetup({ accountResolver: multiple })),
    expectCode('BANK_ACCOUNT_REFERENCE_INVALID'));
});

test('zero account, invisible account and denied C3 share the same external semantics', async () => {
  const absent = createSetup({ accountResolver: createFakeBankAccountResolver([]) });
  const invisible = createSetup({ accountVisible: false });
  const restricted = createSetup({
    summary: summary({ classification: 'C3' }),
    canReadRestricted: async () => false
  });
  for (const setup of [absent, invisible, restricted]) {
    await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
  }
});

test('CB-1-A validation is mandatory before visibility and relation resolution', async () => {
  const invalid = summary();
  invalid.iban = 'CH00-DO-NOT-EXPOSE';
  const setup = createSetup({ summary: invalid, accountVisible: false });
  await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_REFERENCE_INVALID'));
  assert.equal(setup.entityResolver.calls.length, 0);
});

test('account id and tenant contradictions are denied without relation calls', async () => {
  for (const changed of [
    summary({ bankAccountId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
    summary({ tenantId: 'tenant-other' })
  ]) {
    const accountResolver = createFakeBankAccountResolver([
      { summary: changed, visible: true }
    ], { returnAll: true });
    const setup = createSetup({ summary: changed, accountResolver });
    await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
    assert.equal(setup.entityResolver.calls.length, 0);
  }
});

test('C2 bypasses policy while C3 requires strict true', async () => {
  const c2Policy = async () => { throw new Error('must not run'); };
  assert.equal((await resolve(createSetup({ canReadRestricted: c2Policy }))).classification, 'C2');

  for (const decision of [false, 'true', 1, undefined]) {
    const setup = createSetup({
      summary: summary({ classification: 'C3' }),
      entityResolver: createFakeBankAccountResolver([
        relation(summary().holderEntity, { classification: 'C3' })
      ]),
      institutionResolver: createFakeBankAccountResolver([
        institutionRelation({ classification: 'C3' })
      ]),
      canReadRestricted: async () => decision
    });
    await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
  }
});

test('C3 policy receives only the closed frozen decision context', async () => {
  let received;
  const setup = createSetup({
    summary: summary({ classification: 'C3' }),
    entityResolver: createFakeBankAccountResolver([
      relation(summary().holderEntity, { classification: 'C3' })
    ]),
    institutionResolver: createFakeBankAccountResolver([
      institutionRelation({ classification: 'C3' })
    ]),
    canReadRestricted: async query => { received = query; return true; }
  });
  await resolve(setup);
  assert.deepEqual(Object.keys(received), [
    'tenantId', 'actorId', 'bankAccountId', 'classification', 'operation', 'requestAt'
  ]);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(JSON.stringify(received).includes('1234'), false);
  assert.equal(JSON.stringify(received).includes('Etablissement'), false);
});

test('missing, throwing and rejecting C3 policies deny access generically', async () => {
  const restricted = summary({ classification: 'C3' });
  const baseOptions = {
    summary: restricted,
    entityResolver: createFakeBankAccountResolver([
      relation(restricted.holderEntity, { classification: 'C3' })
    ]),
    institutionResolver: createFakeBankAccountResolver([
      institutionRelation({ classification: 'C3' })
    ])
  };
  const missingService = createBankAccountReferencePolicyService({
    accountResolver: createFakeBankAccountResolver([{ summary: restricted, visible: true }]),
    entityResolver: baseOptions.entityResolver,
    institutionResolver: baseOptions.institutionResolver,
    agentResolver: createFakeBankAccountResolver([])
  });
  await assert.rejects(missingService.resolveReadableBankAccountSummary({
    bankAccountId: ACCOUNT_ID, context: context()
  }), expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
  for (const policy of [
    () => { throw new Error('policy failure'); },
    async () => Promise.reject(new Error('policy rejection'))
  ]) {
    await assert.rejects(resolve(createSetup({ ...baseOptions, canReadRestricted: policy })),
      expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
  }
});

test('only active accounts are readable', async () => {
  for (const status of ['candidate', 'verification_pending', 'suspended', 'closed']) {
    const verifiedAt = ['candidate', 'verification_pending'].includes(status)
      ? null
      : '2026-09-11T17:00:00Z';
    const setup = createSetup({ summary: summary({ status, verifiedAt }) });
    await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
    assert.equal(setup.entityResolver.calls.length, 0);
  }
});

test('account effectivity includes both boundaries and rejects future or expired records', async () => {
  for (const overrides of [
    { effectiveFrom: '2026-09-11', effectiveTo: null },
    { effectiveFrom: null, effectiveTo: '2026-09-11' },
    { effectiveFrom: '2026-09-11', effectiveTo: '2026-09-11' }
  ]) assert.equal((await resolve(createSetup({ summary: summary(overrides) }))).status, 'active');

  for (const overrides of [
    { effectiveFrom: '2026-09-12' },
    { effectiveTo: '2026-09-10' }
  ]) await assert.rejects(resolve(createSetup({ summary: summary(overrides) })),
    expectCode('BANK_ACCOUNT_ACCESS_DENIED'));
});

test('entity must match tenant, id, label and source revision', async () => {
  for (const overrides of [
    { tenantId: 'tenant-other' },
    { id: 'entity-other' },
    { labelSnapshot: 'Autre entite' },
    { sourceRevision: 'entity-rev-2' }
  ]) {
    const entityResolver = createFakeBankAccountResolver([
      relation(summary().holderEntity, overrides)
    ], { returnAll: true });
    const setup = createSetup({ entityResolver });
    await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_RELATION_INVALID'));
    assert.equal(setup.institutionResolver.calls.length, 0);
  }
});

test('institution must match tenant, id, revision, country and type', async () => {
  for (const overrides of [
    { tenantId: 'tenant-other' },
    { id: 'institution-other' },
    { sourceRevision: 'institution-rev-2' },
    { countryId: 'SN' },
    { institutionType: 'payment_institution' }
  ]) {
    const institutionResolver = createFakeBankAccountResolver([
      institutionRelation(overrides)
    ], { returnAll: true });
    const setup = createSetup({ institutionResolver });
    await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_RELATION_INVALID'));
    assert.equal(setup.agentResolver.calls.length, 0);
  }
});

test('relations must be active, visible, effective and not more restricted than the account', async () => {
  for (const overrides of [
    { active: false },
    { visible: false },
    { effectiveFrom: '2026-09-12' },
    { effectiveTo: '2026-09-10' },
    { classification: 'C3' }
  ]) {
    const entityResolver = createFakeBankAccountResolver([
      relation(summary().holderEntity, overrides)
    ], { returnAll: true });
    await assert.rejects(resolve(createSetup({ entityResolver })),
      expectCode('BANK_ACCOUNT_RELATION_INVALID'));
  }
});

test('null owner skips agent resolution and a present owner is strictly resolved', async () => {
  const withoutOwner = createSetup();
  await resolve(withoutOwner);
  assert.equal(withoutOwner.agentResolver.calls.length, 0);

  const owner = snapshot('agent-owner-fictional', 'Agent proprietaire fictif', 'agent-rev-1');
  const withOwnerSummary = summary({ businessOwnerAgent: owner });
  const withOwner = createSetup({
    summary: withOwnerSummary,
    agentResolver: createFakeBankAccountResolver([relation(owner)])
  });
  const result = await resolve(withOwner);
  assert.equal(result.businessOwnerAgent.id, owner.id);
  assert.equal(withOwner.agentResolver.calls.length, 1);

  const invalidAgent = createSetup({
    summary: withOwnerSummary,
    agentResolver: createFakeBankAccountResolver([relation(owner, { active: false })])
  });
  await assert.rejects(resolve(invalidAgent), expectCode('BANK_ACCOUNT_RELATION_INVALID'));
});

test('the chain stops on first failure and never exceeds four resolver calls', async () => {
  assert.equal(MAX_RESOLVER_CALLS, 4);
  const entityResolver = createFakeBankAccountResolver([]);
  const setup = createSetup({ entityResolver });
  await assert.rejects(resolve(setup), expectCode('BANK_ACCOUNT_RELATION_INVALID'));
  assert.equal(setup.accountResolver.calls.length, 1);
  assert.equal(setup.entityResolver.calls.length, 1);
  assert.equal(setup.institutionResolver.calls.length, 0);
  assert.equal(setup.agentResolver.calls.length, 0);

  const owner = snapshot('agent-owner-fictional', 'Agent proprietaire fictif', 'agent-rev-1');
  const complete = createSetup({
    summary: summary({ businessOwnerAgent: owner }),
    agentResolver: createFakeBankAccountResolver([relation(owner)])
  });
  await resolve(complete);
  const total = complete.accountResolver.calls.length + complete.entityResolver.calls.length
    + complete.institutionResolver.calls.length + complete.agentResolver.calls.length;
  assert.equal(total, 4);
});

test('resolver queries are exact frozen copies and inputs and source records are not mutated', async () => {
  const source = summary();
  const sourceBefore = structuredClone(source);
  let mutationBlocked = false;
  const accountResolver = createFakeBankAccountResolver([
    { summary: source, visible: true }
  ], {
    mutateQuery(query) {
      try { query.tenantId = 'tenant-attacker'; } catch (_error) { mutationBlocked = true; }
    }
  });
  const setup = createSetup({ summary: source, accountResolver });
  const input = { bankAccountId: ACCOUNT_ID, context: context() };
  const inputBefore = structuredClone(input);
  await setup.service.resolveReadableBankAccountSummary(input);
  assert.equal(mutationBlocked, true);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(Object.keys(accountResolver.calls[0]), [
    'bankAccountId', 'tenantId', 'operation', 'requestAt'
  ]);
  assert.deepEqual(Object.keys(setup.entityResolver.calls[0]), [
    'id', 'tenantId', 'operation', 'requestAt', 'sourceRevision'
  ]);
});

test('the validated account is detached before an asynchronous C3 policy can yield', async () => {
  const source = summary({ classification: 'C3' });
  const accountResolver = async () => {
    setTimeout(() => {
      source.internalLabel = 'Source modifiee apres resolution';
      source.tenantId = 'tenant-attacker';
    }, 0);
    return { available: true, records: [{ summary: source, visible: true }] };
  };
  const setup = createSetup({
    summary: source,
    accountResolver,
    entityResolver: createFakeBankAccountResolver([
      relation(source.holderEntity, { classification: 'C3' })
    ]),
    institutionResolver: createFakeBankAccountResolver([
      institutionRelation({ classification: 'C3' })
    ]),
    canReadRestricted: () => new Promise(resolvePolicy => {
      setTimeout(() => resolvePolicy(true), 10);
    })
  });
  const result = await resolve(setup);
  assert.equal(result.internalLabel, 'Compte fictif masque');
  assert.equal(result.tenantId, 'tenant-fictional');
  assert.equal(source.tenantId, 'tenant-attacker');
});

test('no raw resolver field or sensitive account value reaches the result', async () => {
  const raw = summary();
  raw.secret = 'DO-NOT-EXPOSE';
  const accountResolver = async () => ({
    available: true,
    records: [{ summary: raw, visible: true }]
  });
  await assert.rejects(resolve(createSetup({ summary: raw, accountResolver })),
    expectCode('BANK_ACCOUNT_REFERENCE_INVALID'));

  const safe = summary();
  const setup = createSetup({ summary: safe });
  const result = await resolve(setup);
  assert.equal(Object.hasOwn(result, 'visible'), false);
  assert.equal(Object.hasOwn(result, 'secret'), false);
  assert.equal(JSON.stringify(result).includes('DO-NOT-EXPOSE'), false);
});

test('errors keep bounded own metadata and never expose resolver or banking details', async () => {
  const accountResolver = async () => { throw new Error('IBAN CH00 SECRET Banque privee'); };
  const setup = createSetup({ accountResolver });
  await assert.rejects(resolve(setup), error => {
    assert.equal(Object.hasOwn(error, 'code'), true);
    assert.equal(error.code, 'BANK_ACCOUNT_REFERENCE_UNAVAILABLE');
    assert.equal(error.message, 'Bank account request could not be completed');
    const serialized = JSON.stringify(error);
    assert.equal(serialized.includes('CH00'), false);
    assert.equal(serialized.includes('Banque'), false);
    return true;
  });
});

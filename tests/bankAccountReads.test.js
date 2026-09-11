'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BankAccountReadError,
  CURSOR_VERSION,
  DEFAULT_LIMIT,
  FILTER_KEYS,
  MAX_CANDIDATE_HANDLES,
  MAX_CONCURRENT_RESOLUTIONS,
  SORT_VERSION,
  TOTAL_SCOPE,
  createBankAccountReadService
} = require('../bankAccountReads');
const {
  BankAccountReferenceError,
  createBankAccountReferencePolicyService
} = require('../bankAccountReferences');
const { createFakeBankAccountResolver } = require('./helpers/fakeBankAccountResolver');
const { createFakeBankAccountListResolver } = require('./helpers/fakeBankAccountListResolver');
const { createFakeAuthenticatedCursorCodec } = require('./helpers/fakeAuthenticatedCursorCodec');

const REQUEST_AT = '2026-09-12T10:00:00Z';
const TENANT_ID = 'tenant-fictional';
const ACTOR_ID = 'reader-fictional';
const LIST_REVISION = 'list-rev-fictional-1';

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function holderSnapshot() {
  return {
    id: 'entity-fictional',
    labelSnapshot: 'Entite fictive',
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
    verifiedAt: '2026-09-11T17:00:00Z',
    recordVersion: 1,
    ...overrides
  };
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

function context(overrides = {}) {
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

function handle(account) {
  return {
    bankAccountId: account.bankAccountId,
    internalLabelOrder: account.internalLabel,
    sourceRevision: account.sourceRevision
  };
}

function provenTotal(count, filters = {}, overrides = {}) {
  return {
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    filters,
    listRevision: LIST_REVISION,
    sourceRevision: 'total-rev-fictional-1',
    scope: TOTAL_SCOPE,
    count,
    ...overrides
  };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createReferenceSetup(accounts, options = {}) {
  const accountResolver = async query => ({
    available: true,
    records: accounts
      .filter(account => account.bankAccountId === query.bankAccountId)
      .map(account => ({
        summary: structuredClone(account),
        visible: !options.invisibleIds?.has(account.bankAccountId)
      }))
  });
  const relationClassification = accounts.some(account => account.classification === 'C3')
    ? 'C3'
    : 'C2';
  const baseService = createBankAccountReferencePolicyService({
    accountResolver,
    entityResolver: createFakeBankAccountResolver([
      relation(holderSnapshot(), { classification: relationClassification })
    ]),
    institutionResolver: createFakeBankAccountResolver([
      institutionRelation({ classification: relationClassification })
    ]),
    agentResolver: createFakeBankAccountResolver([]),
    canReadRestricted: async () => options.allowC3 !== false
  });
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const referencePolicyService = Object.freeze({
    async resolveReadableBankAccountSummary(request) {
      calls.push(structuredClone(request));
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (options.delayMs) await sleep(options.delayMs);
        if (options.failIds?.has(request.bankAccountId)) {
          throw new BankAccountReferenceError('BANK_ACCOUNT_REFERENCE_UNAVAILABLE');
        }
        return await baseService.resolveReadableBankAccountSummary(request);
      } finally {
        active -= 1;
      }
    }
  });
  return { referencePolicyService, calls, getMaxActive: () => maxActive };
}

function createSetup(options = {}) {
  const accounts = options.accounts || [summary()];
  const references = options.references || createReferenceSetup(accounts, options.referenceOptions);
  const records = options.records || accounts.map(handle);
  const listResolver = options.listResolver || createFakeBankAccountListResolver({
    records,
    listRevision: options.listRevision || LIST_REVISION,
    hasMore: options.hasMore,
    provenTotal: Object.hasOwn(options, 'provenTotal') ? options.provenTotal : null,
    delayMs: options.listDelayMs,
    ignoreSignal: options.ignoreListSignal,
    available: options.listAvailable,
    throwError: options.listThrowError,
    makeResult: options.makeListResult
  });
  const cursorBundle = options.cursorBundle || createFakeAuthenticatedCursorCodec();
  const factory = {
    referencePolicyService: references.referencePolicyService,
    listResolver,
    cursorCodec: cursorBundle.codec
  };
  if (Object.hasOwn(options, 'resolutionTimeoutMs')) {
    factory.resolutionTimeoutMs = options.resolutionTimeoutMs;
  }
  return {
    service: createBankAccountReadService(factory),
    references,
    listResolver,
    cursorBundle
  };
}

function expectReadCode(code) {
  return error => error instanceof BankAccountReadError
    && error.code === code
    && error.message === 'Bank account read request could not be completed';
}

function expectAnyCode(code) {
  return error => error.code === code
    && !JSON.stringify(error).includes('CH00')
    && !error.message.includes('CH00');
}

async function list(setup, overrides = {}) {
  return setup.service.listBankAccountSummaries({
    context: context(),
    filters: {},
    cursor: null,
    limit: DEFAULT_LIMIT,
    ...overrides
  });
}

test('1 - unit read delegates exactly once to CB-1-B and returns a frozen projection', async () => {
  const setup = createSetup();
  const result = await setup.service.readBankAccountSummary({
    bankAccountId: uuid(1),
    context: context()
  });
  assert.equal(setup.references.calls.length, 1);
  assert.equal(result.bankAccountId, uuid(1));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.holderEntity), true);
});

test('2 - open, inherited, accessor, proxy and symbol request shapes are rejected before sources', async () => {
  const setup = createSetup();
  const accessor = { bankAccountId: uuid(1), context: context() };
  Object.defineProperty(accessor, 'context', { enumerable: true, get: context });
  const symbol = { context: context() };
  symbol[Symbol('hidden')] = true;
  const candidates = [
    { context: context(), unknown: true },
    Object.create({ context: context() }),
    accessor,
    new Proxy({ context: context() }, {}),
    symbol
  ];
  for (const candidate of candidates) {
    await assert.rejects(
      setup.service.listBankAccountSummaries(candidate),
      expectReadCode('BANK_ACCOUNT_REQUEST_INVALID')
    );
  }
  assert.equal(setup.listResolver.calls.length, 0);
  assert.equal(setup.references.calls.length, 0);
});

test('3 - permission and capability gates run before cursor and list resolution', async () => {
  for (const deniedContext of [
    context({ permissions: [] }),
    context({ capabilities: [] })
  ]) {
    const setup = createSetup();
    await assert.rejects(
      list(setup, { context: deniedContext, cursor: 'invalid cursor' }),
      expectReadCode('BANK_ACCOUNT_ACCESS_DENIED')
    );
    assert.equal(setup.listResolver.calls.length, 0);
    assert.equal(setup.cursorBundle.decodeCalls.length, 0);
  }
});

test('4 - the six exact filters are normalized and passed as a frozen closed object', async () => {
  const setup = createSetup();
  const filters = {
    holderEntityId: 'entity-fictional',
    financialInstitutionId: 'institution-fictional',
    accountType: 'OPERATING_CURRENT',
    currency: 'CHF',
    status: 'active',
    classification: 'C2'
  };
  const page = await list(setup, { filters });
  assert.deepEqual(Object.keys(setup.listResolver.calls[0].query.filters), FILTER_KEYS);
  assert.equal(Object.isFrozen(setup.listResolver.calls[0].query.filters), true);
  assert.equal(page.pageCount, 1);
});

test('5 - free search, arrays, unknown filters and invalid enumeration values are refused', async () => {
  const setup = createSetup();
  for (const filters of [
    { search: 'banque' },
    { currency: ['CHF'] },
    { accountType: 'WALLET' },
    { classification: 'PUBLIC' },
    new Proxy({ currency: 'CHF' }, {})
  ]) {
    await assert.rejects(list(setup, { filters }), expectReadCode('BANK_ACCOUNT_REQUEST_INVALID'));
  }
  assert.equal(setup.listResolver.calls.length, 0);
});

test('6 - limits 1, 25 and 50 are accepted while zero, 51 and coercions are refused', async () => {
  for (const accepted of [1, 25, 50]) {
    const setup = createSetup({ accounts: [], records: [] });
    await list(setup, { limit: accepted });
    assert.equal(setup.listResolver.calls[0].snapshot.candidateLimit, accepted + 1);
  }
  const defaultSetup = createSetup({ accounts: [], records: [] });
  await defaultSetup.service.listBankAccountSummaries({ context: context() });
  assert.equal(defaultSetup.listResolver.calls[0].snapshot.candidateLimit, 26);
  for (const refused of [0, 51, '25', 1.5, null]) {
    const setup = createSetup({ accounts: [], records: [] });
    await assert.rejects(list(setup, { limit: refused }), expectReadCode('BANK_ACCOUNT_REQUEST_INVALID'));
    assert.equal(setup.listResolver.calls.length, 0);
  }
});

test('7 - one list call examines at most 51 handles and exposes at most 50 items', async () => {
  const accounts = Array.from({ length: MAX_CANDIDATE_HANDLES }, (_, index) => summary(index + 1));
  const setup = createSetup({ accounts });
  const page = await list(setup, { limit: 50 });
  assert.equal(setup.listResolver.calls.length, 1);
  assert.equal(setup.listResolver.calls[0].snapshot.candidateLimit, 51);
  assert.equal(setup.references.calls.length, 51);
  assert.equal(page.pageCount, 50);
  assert.equal(page.hasMore, true);
});

test('8 - handle order follows Unicode code points rather than locale or UTF-16 shortcuts', async () => {
  const first = summary(1, { internalLabel: '\uE000' });
  const second = summary(2, { internalLabel: '\u{10000}' });
  const setup = createSetup({ accounts: [first, second], records: [handle(first), handle(second)] });
  const page = await list(setup);
  assert.deepEqual(page.items.map(item => item.bankAccountId), [uuid(1), uuid(2)]);
});

test('9 - equal labels are deterministically ordered by bankAccountId', async () => {
  const first = summary(1, { internalLabel: 'Compte commun' });
  const second = summary(2, { internalLabel: 'Compte commun' });
  const page = await list(createSetup({ accounts: [first, second] }));
  assert.deepEqual(page.items.map(item => item.bankAccountId), [uuid(1), uuid(2)]);
});

test('10 - duplicates, reversed order and handle projection contradictions fail the whole page', async () => {
  const first = summary(1);
  const second = summary(2);
  for (const records of [
    [handle(first), handle(first)],
    [handle(second), handle(first)],
    [{ ...handle(first), sourceRevision: 'contradictory-revision' }]
  ]) {
    const setup = createSetup({ accounts: [first, second], records });
    await assert.rejects(list(setup), expectReadCode('BANK_ACCOUNT_LIST_INVALID'));
  }
});

test('11 - an account that becomes absent or invisible is omitted without diagnostic', async () => {
  const first = summary(1);
  const absentReferences = createReferenceSetup([]);
  const absent = createSetup({
    accounts: [],
    records: [handle(first)],
    references: absentReferences,
    provenTotal: provenTotal(1)
  });
  const absentPage = await list(absent);
  assert.equal(absentPage.pageCount, 0);
  assert.equal(absentPage.totalCount, null);
  assert.equal(absentPage.totalStatus, 'unavailable');

  const invisible = createSetup({
    accounts: [first],
    referenceOptions: { invisibleIds: new Set([first.bankAccountId]) },
    provenTotal: provenTotal(1)
  });
  const invisiblePage = await list(invisible);
  assert.equal(invisiblePage.pageCount, 0);
  assert.equal(invisiblePage.totalCount, null);
  assert.equal(invisiblePage.totalStatus, 'unavailable');
});

test('12 - denied accounts and a hidden sentinel close pagination without disclosure', async () => {
  const restricted = [
    summary(1, { classification: 'C3' }),
    summary(2, { classification: 'C3' })
  ];
  const setup = createSetup({
    accounts: restricted,
    referenceOptions: { allowC3: false }
  });
  const page = await list(setup, { filters: { classification: 'C3' }, limit: 1 });
  assert.equal(page.pageCount, 0);
  assert.equal(page.totalCount, null);
  assert.equal(page.totalStatus, 'unavailable');
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(setup.cursorBundle.encodeCalls.length, 0);

  const mixedAccounts = [summary(1), summary(2)];
  const hiddenSentinel = createSetup({
    accounts: mixedAccounts,
    referenceOptions: { invisibleIds: new Set([uuid(2)]) },
    provenTotal: provenTotal(2)
  });
  const mixedPage = await list(hiddenSentinel, { limit: 1 });
  assert.equal(mixedPage.pageCount, 1);
  assert.equal(mixedPage.items[0].bankAccountId, uuid(1));
  assert.equal(mixedPage.hasMore, false);
  assert.equal(mixedPage.nextCursor, null);
  assert.equal(mixedPage.totalCount, null);
  assert.equal(hiddenSentinel.references.calls.length, 2);
  assert.equal(hiddenSentinel.cursorBundle.encodeCalls.length, 0);
});

test('13 - one unavailable account source refuses the whole page instead of returning a partial result', async () => {
  const accounts = [summary(1), summary(2)];
  const setup = createSetup({
    accounts,
    referenceOptions: { failIds: new Set([uuid(2)]) }
  });
  await assert.rejects(list(setup), expectAnyCode('BANK_ACCOUNT_REFERENCE_UNAVAILABLE'));
});

test('14 - no more than four bank account resolutions run concurrently', async () => {
  const accounts = Array.from({ length: 9 }, (_, index) => summary(index + 1));
  const setup = createSetup({
    accounts,
    referenceOptions: { delayMs: 15 },
    resolutionTimeoutMs: 100
  });
  const page = await list(setup, { limit: 9 });
  assert.equal(page.pageCount, 9);
  assert.equal(setup.references.getMaxActive(), MAX_CONCURRENT_RESOLUTIONS);
});

test('15 - timed-out non-cooperative resolutions retain the four shared service slots', async () => {
  const accounts = Array.from({ length: 8 }, (_, index) => summary(index + 1));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const referencePolicyService = Object.freeze({
    async resolveReadableBankAccountSummary(request) {
      calls.push(structuredClone(request));
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return accounts.find(account => account.bankAccountId === request.bankAccountId);
    }
  });
  const setup = createSetup({
    accounts,
    references: {
      referencePolicyService,
      calls,
      getMaxActive: () => maxActive
    },
    resolutionTimeoutMs: 10
  });
  await assert.rejects(list(setup, { limit: 8 }), expectReadCode('BANK_ACCOUNT_LIST_UNAVAILABLE'));
  assert.equal(active, 4);
  assert.equal(calls.length, 4);
  await assert.rejects(
    setup.service.readBankAccountSummary({ bankAccountId: uuid(1), context: context() }),
    expectReadCode('BANK_ACCOUNT_REFERENCE_UNAVAILABLE')
  );
  assert.equal(active, 4);
  assert.equal(calls.length, 4);
  await assert.rejects(list(setup, { limit: 8 }), expectReadCode('BANK_ACCOUNT_LIST_UNAVAILABLE'));
  assert.equal(active, 4);
  assert.equal(calls.length, 4);
  release();
  await sleep(5);
  assert.equal(maxActive, 4);
  assert.equal(calls.length, 4);
});

test('16 - cursor is bound to tenant and actor', async () => {
  const accounts = [summary(1), summary(2)];
  const setup = createSetup({ accounts });
  const cursor = (await list(setup, { limit: 1 })).nextCursor;
  for (const changed of [
    context({ tenantId: 'tenant-other' }),
    context({ actorId: 'reader-other' })
  ]) {
    await assert.rejects(
      list(setup, { context: changed, limit: 1, cursor }),
      expectReadCode('BANK_ACCOUNT_CURSOR_INVALID')
    );
  }
});

test('17 - cursor is bound to filters, limit and sort version', async () => {
  const accounts = [summary(1), summary(2)];
  const setup = createSetup({ accounts });
  const cursor = (await list(setup, { filters: { currency: 'CHF' }, limit: 1 })).nextCursor;
  await assert.rejects(
    list(setup, { filters: { currency: 'XOF' }, limit: 1, cursor }),
    expectReadCode('BANK_ACCOUNT_CURSOR_INVALID')
  );
  await assert.rejects(
    list(setup, { filters: { currency: 'CHF' }, limit: 2, cursor }),
    expectReadCode('BANK_ACCOUNT_CURSOR_INVALID')
  );
  const payload = setup.cursorBundle.encodeCalls[0];
  const wrongSort = await setup.cursorBundle.codec.encode({ ...payload, sortVersion: 'OTHER_SORT' });
  await assert.rejects(
    list(setup, { filters: { currency: 'CHF' }, limit: 1, cursor: wrongSort }),
    expectReadCode('BANK_ACCOUNT_CURSOR_INVALID')
  );
});

test('18 - expired, tampered and list-revision-divergent cursors are refused', async () => {
  const accounts = [summary(1), summary(2)];
  const setup = createSetup({ accounts });
  const cursor = (await list(setup, { limit: 1 })).nextCursor;
  const payload = setup.cursorBundle.encodeCalls[0];
  const expired = await setup.cursorBundle.codec.encode({
    ...payload,
    issuedAt: '2026-09-12T09:00:00Z',
    expiresAt: '2026-09-12T09:30:00Z'
  });
  await assert.rejects(list(setup, { limit: 1, cursor: expired }), expectReadCode('BANK_ACCOUNT_CURSOR_INVALID'));
  await assert.rejects(list(setup, { limit: 1, cursor: `${cursor}x` }), expectReadCode('BANK_ACCOUNT_CURSOR_INVALID'));
  const changedRevision = createSetup({
    accounts,
    cursorBundle: setup.cursorBundle,
    listRevision: 'list-rev-fictional-2'
  });
  await assert.rejects(
    list(changedRevision, { limit: 1, cursor }),
    expectReadCode('BANK_ACCOUNT_CURSOR_INVALID')
  );
  const stagnant = createSetup({
    accounts,
    cursorBundle: setup.cursorBundle,
    makeListResult: () => ({
      available: true,
      listRevision: LIST_REVISION,
      records: [handle(accounts[0])],
      hasMore: true,
      provenTotal: null
    })
  });
  await assert.rejects(
    list(stagnant, { limit: 1, cursor }),
    expectReadCode('BANK_ACCOUNT_LIST_INVALID')
  );
  const hostileInstant = {
    [Symbol.toPrimitive]() {
      throw new Error('IBAN CH04 SECRET Banque privee');
    }
  };
  const hostileCursorBundle = {
    codec: Object.freeze({
      async encode() { return 'unused.cursor'; },
      async decode() { return { ...payload, issuedAt: hostileInstant }; }
    }),
    encodeCalls: [],
    decodeCalls: []
  };
  const hostile = createSetup({ accounts, cursorBundle: hostileCursorBundle });
  await assert.rejects(list(hostile, { limit: 1, cursor: 'hostile.cursor' }), error => {
    assert.equal(expectReadCode('BANK_ACCOUNT_CURSOR_INVALID')(error), true);
    assert.equal(error.message.includes('Banque'), false);
    assert.equal(error.stack.includes('CH04'), false);
    return true;
  });
});

test('19 - missing or open cursor codecs are rejected with no fallback encoding', () => {
  const references = createReferenceSetup([summary()]);
  const listResolver = createFakeBankAccountListResolver({ records: [handle(summary())] });
  assert.throws(() => createBankAccountReadService({
    referencePolicyService: references.referencePolicyService,
    listResolver
  }), expectReadCode('BANK_ACCOUNT_REQUEST_INVALID'));
  assert.throws(() => createBankAccountReadService({
    referencePolicyService: references.referencePolicyService,
    listResolver,
    cursorCodec: { encode: async () => 'token', decode: async () => ({}), rawSecret: 'forbidden' }
  }), expectReadCode('BANK_ACCOUNT_REQUEST_INVALID'));
});

test('20 - pageCount, hasMore and nextCursor remain distinct across bounded pages', async () => {
  const accounts = [summary(1), summary(2)];
  const setup = createSetup({ accounts });
  const first = await list(setup, { limit: 1 });
  assert.deepEqual(
    { pageCount: first.pageCount, hasMore: first.hasMore, cursor: typeof first.nextCursor },
    { pageCount: 1, hasMore: true, cursor: 'string' }
  );
  const decodedFragments = first.nextCursor
    .split('.')
    .map(fragment => Buffer.from(fragment, 'base64url').toString('utf8'))
    .join('');
  assert.equal(first.nextCursor.includes(uuid(1)), false);
  assert.equal(decodedFragments.includes(uuid(1)), false);
  assert.equal(decodedFragments.includes('bankAccountId'), false);
  const second = await list(setup, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].bankAccountId, uuid(2));
  assert.equal(second.pageCount, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test('21 - missing total proof produces null and unavailable rather than zero', async () => {
  const page = await list(createSetup());
  assert.equal(page.totalCount, null);
  assert.equal(page.totalStatus, 'unavailable');
});

test('22 - a proven zero is preserved as zero', async () => {
  const setup = createSetup({
    accounts: [],
    records: [],
    provenTotal: provenTotal(0)
  });
  const page = await list(setup);
  assert.equal(page.pageCount, 0);
  assert.equal(page.totalCount, 0);
  assert.equal(page.totalStatus, 'proven');
});

test('23 - raw, contradictory or under-counted totals are ignored without invalidating the page', async () => {
  for (const total of [
    provenTotal(1, {}, { scope: 'raw_all_accounts' }),
    provenTotal(1, {}, { tenantId: 'tenant-other' }),
    provenTotal(0)
  ]) {
    const page = await list(createSetup({ provenTotal: total }));
    assert.equal(page.pageCount, 1);
    assert.equal(page.totalCount, null);
    assert.equal(page.totalStatus, 'unavailable');
  }
  const visibleSentinel = await list(createSetup({
    accounts: [summary(1), summary(2)],
    provenTotal: provenTotal(1)
  }), { limit: 1 });
  assert.equal(visibleSentinel.pageCount, 1);
  assert.equal(visibleSentinel.hasMore, true);
  assert.equal(visibleSentinel.totalCount, null);
  assert.equal(visibleSentinel.totalStatus, 'unavailable');
});

test('24 - list output is detached and deeply frozen', async () => {
  const source = summary();
  const setup = createSetup({ accounts: [source] });
  const page = await list(setup);
  source.internalLabel = 'Source modifiee';
  source.holderEntity.labelSnapshot = 'Source imbriquee modifiee';
  assert.equal(page.items[0].internalLabel, 'Compte fictif 001');
  assert.equal(page.items[0].holderEntity.labelSnapshot, 'Entite fictive');
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.items), true);
  assert.equal(Object.isFrozen(page.items[0].holderEntity), true);
});

test('25 - source failures expose bounded generic errors without banking details', async () => {
  const leakedReadError = new BankAccountReadError('BANK_ACCOUNT_LIST_INVALID');
  leakedReadError.secret = 'IBAN CH00 SECRET Banque privee';
  const leakedReferenceError = new BankAccountReferenceError('BANK_ACCOUNT_REFERENCE_INVALID');
  leakedReferenceError.secret = 'IBAN CH01 SECRET Banque privee';
  function proxiedError(error, secret) {
    return new Proxy(error, {
      get(target, property, receiver) {
        if (property === 'code') throw new Error(secret);
        return Reflect.get(target, property, receiver);
      }
    });
  }
  const proxiedReadError = proxiedError(
    new BankAccountReadError('BANK_ACCOUNT_LIST_INVALID'),
    'IBAN CH02 SECRET Banque privee'
  );
  const proxiedReferenceError = proxiedError(
    new BankAccountReferenceError('BANK_ACCOUNT_ACCESS_DENIED'),
    'IBAN CH03 SECRET Banque privee'
  );
  for (const { setup, invoke, code } of [
    {
      setup: createSetup({ listResolver: async () => { throw leakedReadError; } }),
      invoke: candidate => list(candidate),
      code: 'BANK_ACCOUNT_LIST_INVALID'
    },
    {
      setup: createSetup({
        references: {
          referencePolicyService: Object.freeze({
            async resolveReadableBankAccountSummary() { throw leakedReferenceError; }
          }),
          calls: [],
          getMaxActive: () => 0
        }
      }),
      invoke: candidate => candidate.service.readBankAccountSummary({
        bankAccountId: uuid(1),
        context: context()
      }),
      code: 'BANK_ACCOUNT_REFERENCE_INVALID'
    },
    {
      setup: createSetup({ listResolver: async () => { throw proxiedReadError; } }),
      invoke: candidate => list(candidate),
      code: 'BANK_ACCOUNT_LIST_UNAVAILABLE'
    },
    {
      setup: createSetup({
        references: {
          referencePolicyService: Object.freeze({
            async resolveReadableBankAccountSummary() { throw proxiedReferenceError; }
          }),
          calls: [],
          getMaxActive: () => 0
        }
      }),
      invoke: candidate => list(candidate),
      code: 'BANK_ACCOUNT_REFERENCE_UNAVAILABLE'
    }
  ]) {
    await assert.rejects(invoke(setup), error => {
      assert.equal(error.code, code);
      assert.equal(Object.hasOwn(error, 'secret'), false);
      assert.equal(error.message.includes('Banque'), false);
      assert.equal(JSON.stringify(error).includes('CH0'), false);
      assert.equal(error.stack.includes('CH0'), false);
      return true;
    });
  }
});

test('26 - the pure service exposes only read and list and uses only injected doubles', async () => {
  const setup = createSetup({ accounts: [], records: [] });
  assert.deepEqual(Object.keys(setup.service), [
    'readBankAccountSummary', 'listBankAccountSummaries'
  ]);
  assert.equal(setup.listResolver.calls.length, 0);
  assert.equal(setup.references.calls.length, 0);
  const page = await list(setup);
  assert.equal(page.pageCount, 0);
  assert.equal(setup.listResolver.calls.length, 1);
  assert.equal(setup.references.calls.length, 0);
  assert.equal(setup.cursorBundle.encodeCalls.length, 0);
  assert.equal(setup.cursorBundle.decodeCalls.length, 0);
  assert.equal(CURSOR_VERSION, 1);
  assert.equal(SORT_VERSION, 'INTERNAL_LABEL_ACCOUNT_ID_V1');
});

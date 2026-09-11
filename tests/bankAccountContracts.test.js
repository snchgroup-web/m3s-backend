const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCOUNT_CLASSIFICATIONS,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  BankAccountContractError,
  INSTITUTION_TYPES,
  ISO_4217_CODES,
  ISO_4217_PUBLICATION_DATE,
  MAX_MASKED_IDENTIFIER_LENGTH,
  MAX_RECORD_VERSION,
  projectBankAccountSummaryV1,
  validateBankAccountSummaryV1
} = require('../bankAccountContracts');

const holderEntity = () => ({
  id: 'entity-2sg-fictional',
  labelSnapshot: 'Organisation fictive',
  sourceRevision: 'entity-rev-1'
});

const financialInstitution = () => ({
  id: 'institution-fictional',
  labelSnapshot: 'Etablissement fictif',
  countryId: 'CH',
  institutionType: 'bank',
  sourceRevision: 'institution-rev-1'
});

const businessOwnerAgent = () => ({
  id: 'agent-fictional',
  labelSnapshot: 'Agent fictif',
  sourceRevision: 'agent-rev-1'
});

const summary = () => ({
  bankAccountId: '11111111-2222-4333-8444-555555555555',
  tenantId: 'tenant-fictional',
  holderEntity: holderEntity(),
  financialInstitution: financialInstitution(),
  internalLabel: 'Compte de test fictif',
  accountType: 'OPERATING_CURRENT',
  currency: 'CHF',
  status: 'verification_pending',
  maskedIdentifier: '********1234',
  classification: 'C3',
  businessOwnerAgent: null,
  effectiveFrom: null,
  effectiveTo: null,
  sourceRevision: 'account-rev-1',
  verifiedAt: null,
  recordVersion: 1
});

function rejects(mutate) {
  const candidate = summary();
  mutate(candidate);
  assert.throws(
    () => validateBankAccountSummaryV1(candidate),
    error => error instanceof BankAccountContractError
      && error.code === 'BANK_ACCOUNT_REFERENCE_INVALID'
  );
}

test('the valid closed summary is accepted without mutation', () => {
  const candidate = summary();
  const before = structuredClone(candidate);
  assert.equal(validateBankAccountSummaryV1(candidate), candidate);
  assert.deepEqual(candidate, before);
});

test('root and nested objects reject missing, unknown, inherited and symbol fields', () => {
  rejects(value => { value.balance = '100'; });
  rejects(value => { delete value.maskedIdentifier; });
  rejects(value => { value.holderEntity.legalName = 'Hidden'; });
  rejects(value => { delete value.holderEntity.sourceRevision; });
  rejects(value => { value.financialInstitution.bic = 'HIDDEN'; });
  rejects(value => { delete value.financialInstitution.countryId; });
  rejects(value => { value[Symbol('hidden')] = true; });
  rejects(value => {
    value.holderEntity = Object.create(holderEntity());
  });
  assert.throws(
    () => validateBankAccountSummaryV1([]),
    BankAccountContractError
  );

  const nonEnumerable = summary();
  Object.defineProperty(nonEnumerable, 'tenantId', {
    value: nonEnumerable.tenantId,
    enumerable: false
  });
  assert.throws(
    () => validateBankAccountSummaryV1(nonEnumerable),
    BankAccountContractError
  );

  let getterReads = 0;
  const accessor = summary();
  Object.defineProperty(accessor, 'tenantId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'tenant-fictional';
    }
  });
  assert.throws(
    () => validateBankAccountSummaryV1(accessor),
    BankAccountContractError
  );
  assert.equal(getterReads, 0);
});

test('identifiers are bounded safe references and the account id is a UUID', () => {
  const mutations = [
    value => { value.bankAccountId = 'account-1'; },
    value => { value.tenantId = ''; },
    value => { value.tenantId = 'tenant with spaces'; },
    value => { value.holderEntity.id = 'x'.repeat(129); },
    value => { value.financialInstitution.countryId = 'SÉ'; },
    value => { value.sourceRevision = '../revision'; }
  ];
  for (const mutation of mutations) rejects(mutation);
});

test('labels support normalized Unicode but reject whitespace and control characters', () => {
  const valid = summary();
  valid.internalLabel = 'Compte Zürich';
  valid.holderEntity.labelSnapshot = 'SeneSwiss Group';
  assert.doesNotThrow(() => validateBankAccountSummaryV1(valid));

  const mutations = [
    value => { value.internalLabel = ''; },
    value => { value.internalLabel = ' Compte'; },
    value => { value.internalLabel = 'Compte\ncache'; },
    value => { value.internalLabel = 'x'.repeat(121); },
    value => { value.holderEntity.labelSnapshot = 'e\u0301'; },
    value => { value.financialInstitution.labelSnapshot = 'Banque\u202Etest'; }
  ];
  for (const mutation of mutations) rejects(mutation);
});

test('enumerations are immutable and reject wallets, cards, cash and transfer services', () => {
  assert.deepEqual(ACCOUNT_TYPES, [
    'OPERATING_CURRENT',
    'RESERVE_SAVINGS',
    'COLLECTION',
    'PROJECT_DEDICATED',
    'PAYMENT_ACCOUNT'
  ]);
  assert.deepEqual(ACCOUNT_STATUSES, [
    'candidate', 'verification_pending', 'active', 'suspended', 'closed'
  ]);
  assert.deepEqual(ACCOUNT_CLASSIFICATIONS, ['C2', 'C3']);
  assert.deepEqual(INSTITUTION_TYPES, [
    'bank', 'payment_institution', 'other_regulated_institution'
  ]);
  assert.equal(Object.isFrozen(ACCOUNT_TYPES), true);
  assert.equal(Object.isFrozen(ACCOUNT_STATUSES), true);
  assert.equal(Object.isFrozen(ACCOUNT_CLASSIFICATIONS), true);
  assert.equal(Object.isFrozen(INSTITUTION_TYPES), true);

  for (const accountType of [
    'MOBILE_WALLET', 'PAYMENT_CARD', 'CASH_REGISTER', 'TRANSFER_SERVICE'
  ]) rejects(value => { value.accountType = accountType; });
  rejects(value => { value.status = 'approved'; });
  rejects(value => { value.classification = 'C1'; });
  rejects(value => { value.classification = 'C5'; });
  rejects(value => { value.financialInstitution.institutionType = 'wallet'; });
});

test('currency follows the frozen SIX ISO 4217 list and is never inferred', () => {
  assert.equal(ISO_4217_PUBLICATION_DATE, '2026-01-01');
  assert.equal(ISO_4217_CODES.length, 178);
  assert.equal(Object.isFrozen(ISO_4217_CODES), true);
  for (const currency of ['CHF', 'XOF', 'EUR', 'CHE', 'CHW', 'XAD']) {
    const candidate = summary();
    candidate.currency = currency;
    assert.doesNotThrow(() => validateBankAccountSummaryV1(candidate));
  }
  for (const currency of ['BGN', 'CFA', 'chf', 'EU', 'EURO', '', null]) {
    rejects(value => { value.currency = currency; });
  }
});

test('masked identifiers expose no more than four trailing characters', () => {
  const valid = [
    '********',
    '********1234',
    '******************************AB12',
    '*'.repeat(MAX_MASKED_IDENTIFIER_LENGTH)
  ];
  for (const maskedIdentifier of valid) {
    const candidate = summary();
    candidate.maskedIdentifier = maskedIdentifier;
    assert.doesNotThrow(() => validateBankAccountSummaryV1(candidate));
  }

  const invalid = [
    '****123',
    '***12345',
    'CH******1234',
    '****-1234',
    '*'.repeat(MAX_MASKED_IDENTIFIER_LENGTH + 1),
    1234,
    null
  ];
  for (const maskedIdentifier of invalid) {
    rejects(value => { value.maskedIdentifier = maskedIdentifier; });
  }
});

test('status, verification and effectivity dates remain coherent', () => {
  const candidate = summary();
  candidate.status = 'active';
  candidate.verifiedAt = '2026-09-11T17:00:00Z';
  candidate.effectiveFrom = '2026-01-01';
  candidate.effectiveTo = '2026-12-31';
  assert.doesNotThrow(() => validateBankAccountSummaryV1(candidate));

  const mutations = [
    value => { value.status = 'candidate'; value.verifiedAt = '2026-09-11T17:00:00Z'; },
    value => {
      value.status = 'verification_pending';
      value.verifiedAt = '2026-09-11T17:00:00Z';
    },
    value => { value.status = 'active'; value.verifiedAt = null; },
    value => { value.status = 'suspended'; value.verifiedAt = null; },
    value => { value.status = 'closed'; value.verifiedAt = null; },
    value => { value.verifiedAt = '2026-09-11 17:00:00'; },
    value => { value.verifiedAt = '2026-02-30T17:00:00Z'; },
    value => { value.effectiveFrom = '2026-02-30'; },
    value => { value.effectiveFrom = '2026-12-31'; value.effectiveTo = '2026-01-01'; }
  ];
  for (const mutation of mutations) rejects(mutation);
});

test('record versions are strict bounded integers', () => {
  for (const recordVersion of [1, MAX_RECORD_VERSION]) {
    const candidate = summary();
    candidate.recordVersion = recordVersion;
    assert.doesNotThrow(() => validateBankAccountSummaryV1(candidate));
  }
  for (const recordVersion of [0, MAX_RECORD_VERSION + 1, 1.5, '1', null]) {
    rejects(value => { value.recordVersion = recordVersion; });
  }
});

test('the optional business owner is either null or an exact reference snapshot', () => {
  const candidate = summary();
  candidate.businessOwnerAgent = businessOwnerAgent();
  assert.doesNotThrow(() => validateBankAccountSummaryV1(candidate));

  rejects(value => { value.businessOwnerAgent = {}; });
  rejects(value => {
    value.businessOwnerAgent = businessOwnerAgent();
    value.businessOwnerAgent.role = 'signatory';
  });
  rejects(value => { value.businessOwnerAgent = 'agent-fictional'; });
});

test('projection strips sensitive and unknown source fields and deeply freezes output', () => {
  const source = {
    ...summary(),
    iban: 'CH00-DO-NOT-EXPOSE',
    accountNumber: 'DO-NOT-EXPOSE',
    balance: '999999',
    signatories: ['hidden'],
    secret: 'hidden',
    holderEntity: { ...holderEntity(), legalName: 'Hidden legal name' },
    financialInstitution: { ...financialInstitution(), bic: 'HIDDEN' }
  };
  const before = structuredClone(source);
  const projected = projectBankAccountSummaryV1(source);

  assert.deepEqual(Object.keys(projected), [
    'bankAccountId', 'tenantId', 'holderEntity', 'financialInstitution',
    'internalLabel', 'accountType', 'currency', 'status', 'maskedIdentifier',
    'classification', 'businessOwnerAgent', 'effectiveFrom', 'effectiveTo',
    'sourceRevision', 'verifiedAt', 'recordVersion'
  ]);
  for (const forbidden of [
    'iban', 'accountNumber', 'balance', 'signatories', 'secret'
  ]) assert.equal(Object.hasOwn(projected, forbidden), false);
  assert.equal(Object.hasOwn(projected.holderEntity, 'legalName'), false);
  assert.equal(Object.hasOwn(projected.financialInstitution, 'bic'), false);
  assert.equal(JSON.stringify(projected).includes('DO-NOT-EXPOSE'), false);
  assert.equal(JSON.stringify(projected).includes('999999'), false);
  assert.equal(JSON.stringify(projected).includes('Hidden legal name'), false);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.holderEntity), true);
  assert.equal(Object.isFrozen(projected.financialInstitution), true);
  assert.deepEqual(source, before);
});

test('projection copies and freezes a non-null business owner independently', () => {
  const source = summary();
  source.businessOwnerAgent = businessOwnerAgent();
  const projected = projectBankAccountSummaryV1(source);
  source.businessOwnerAgent.labelSnapshot = 'Source modifiee';
  assert.equal(projected.businessOwnerAgent.labelSnapshot, 'Agent fictif');
  assert.equal(Object.isFrozen(projected.businessOwnerAgent), true);
});

test('projection rejects invalid or hostile source shapes with a generic error', () => {
  assert.throws(() => projectBankAccountSummaryV1(null), BankAccountContractError);
  assert.throws(() => projectBankAccountSummaryV1([]), BankAccountContractError);
  const source = summary();
  source.holderEntity = null;
  assert.throws(
    () => projectBankAccountSummaryV1(source),
    error => error instanceof BankAccountContractError
      && error.code === 'BANK_ACCOUNT_REFERENCE_INVALID'
  );

  const previousTenantId = Object.getOwnPropertyDescriptor(Object.prototype, 'tenantId');
  const pollutedSource = summary();
  delete pollutedSource.tenantId;
  Object.defineProperty(Object.prototype, 'tenantId', {
    value: 'tenant-attacker',
    configurable: true
  });
  try {
    assert.throws(
      () => projectBankAccountSummaryV1(pollutedSource),
      BankAccountContractError
    );
  } finally {
    if (previousTenantId) {
      Object.defineProperty(Object.prototype, 'tenantId', previousTenantId);
    } else {
      delete Object.prototype.tenantId;
    }
  }

  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.throws(
    () => validateBankAccountSummaryV1(revocable.proxy),
    error => error instanceof BankAccountContractError
      && error.code === 'BANK_ACCOUNT_REFERENCE_INVALID'
  );
  assert.throws(
    () => projectBankAccountSummaryV1(revocable.proxy),
    error => error instanceof BankAccountContractError
      && error.code === 'BANK_ACCOUNT_REFERENCE_INVALID'
  );

  let inheritedReads = 0;
  const inheritedTarget = summary();
  delete inheritedTarget.tenantId;
  const inheritedSource = new Proxy(inheritedTarget, {
    get(target, property, receiver) {
      if (property === 'tenantId') {
        inheritedReads += 1;
        return 'tenant-attacker';
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => projectBankAccountSummaryV1(inheritedSource),
    error => error instanceof BankAccountContractError
      && error.code === 'BANK_ACCOUNT_REFERENCE_INVALID'
  );
  assert.equal(inheritedReads, 0);

  let substitutionReads = 0;
  const substitutedSource = new Proxy(summary(), {
    get(target, property, receiver) {
      if (property === 'tenantId') {
        substitutionReads += 1;
        return 'tenant-attacker';
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => validateBankAccountSummaryV1(substitutedSource),
    BankAccountContractError
  );
  assert.throws(
    () => projectBankAccountSummaryV1(substitutedSource),
    BankAccountContractError
  );
  assert.equal(substitutionReads, 0);
});

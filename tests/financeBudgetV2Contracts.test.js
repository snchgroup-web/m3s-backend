const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BudgetV2ContractError,
  MAX_ROWS,
  validateBudgetV2,
  validateBudgetV2CreateBody,
  validateBudgetV2UpdateBody
} = require('../financeBudgetV2Contracts');

const dimensions = () => ({
  functionId: 'management_governance',
  teamId: null,
  agentId: null,
  countryId: 'CH',
  portfolioId: 'PORT-2SG-GLOBAL',
  dossierId: 'GD-001',
  projectId: null,
  phaseId: null
});

const periods = () => Array.from({ length: 12 }, (_, index) => ({
  periodId: `FY-2SG-2027-P${String(index + 1).padStart(2, '0')}`,
  value: index === 0 ? '0' : ''
}));

const row = (id = 'row-1') => ({
  id,
  label: 'Frais administratifs',
  kind: 'operating',
  direction: 'out',
  currency: 'CHF',
  periodValues: periods(),
  dimensions: dimensions()
});

const budget = () => ({
  title: 'Budget de fonctionnement 2SG',
  identity: { entityId: 'ORG-2SG', fiscalYearId: 'FY-2SG-2027' },
  responsibilities: { budgetOwnerAgentId: 'agent-id', controllerAgentId: null },
  rate: '710',
  rateSource: 'Source documentee',
  rateDate: '2026-09-07',
  rows: [row()]
});

const createBody = () => ({ contractVersion: 2, budget: budget() });
const updateBody = () => ({ ...createBody(), expectedVersion: 1 });

function rejects(mutate, update = false) {
  const body = update ? updateBody() : createBody();
  mutate(body);
  assert.throws(
    () => update ? validateBudgetV2UpdateBody(body) : validateBudgetV2CreateBody(body),
    error => error instanceof BudgetV2ContractError && error.code === 'BUDGET_REQUEST_INVALID'
  );
}

test('valid V2 create and update bodies preserve decimal strings, zero, gaps and null dimensions', () => {
  const create = createBody();
  create.budget.rows[0].periodValues[1].value = '1234,50';
  create.budget.rows[0].dimensions.teamId = 'TZH';
  const before = structuredClone(create);
  assert.deepEqual(JSON.parse(validateBudgetV2CreateBody(create)), before);
  assert.deepEqual(create, before);

  const update = { ...structuredClone(create), expectedVersion: 999999 };
  assert.deepEqual(JSON.parse(validateBudgetV2UpdateBody(update)), update);
});

test('empty rows and an entirely absent rate triplet remain valid', () => {
  const body = createBody();
  body.budget.rows = [];
  body.budget.rate = '';
  body.budget.rateSource = '';
  body.budget.rateDate = '';
  assert.doesNotThrow(() => validateBudgetV2CreateBody(body));
});

test('create and update envelopes are closed and versioned exactly', () => {
  rejects(body => { body.contractVersion = 1; });
  rejects(body => { body.expectedVersion = 1; });
  rejects(body => { body.referenceSnapshots = {}; });
  rejects(body => { body.promotion = {}; });
  rejects(body => { delete body.contractVersion; });
  rejects(body => { delete body.expectedVersion; }, true);
  rejects(body => { body.expectedVersion = 0; }, true);
  rejects(body => { body.expectedVersion = 1000000; }, true);
  rejects(body => { body.expectedVersion = '1'; }, true);
  assert.doesNotThrow(() => validateBudgetV2UpdateBody(updateBody()));
});

test('every V2 object rejects missing and unknown fields', () => {
  const mutations = [
    body => { body.budget.unknown = true; },
    body => { delete body.budget.title; },
    body => { body.budget.identity.label = '2SG'; },
    body => { delete body.budget.identity.entityId; },
    body => { body.budget.responsibilities.approverAgentId = null; },
    body => { delete body.budget.responsibilities.controllerAgentId; },
    body => { body.budget.rows[0].actual = '0'; },
    body => { delete body.budget.rows[0].dimensions; },
    body => { body.budget.rows[0].periodValues[0].label = 'Janvier'; },
    body => { delete body.budget.rows[0].periodValues[0].value; },
    body => { body.budget.rows[0].dimensions.costCenterId = null; },
    body => { delete body.budget.rows[0].dimensions.phaseId; }
  ];
  for (const mutation of mutations) rejects(mutation);
});

test('reference identifiers are required, bounded visible ASCII or explicit null where allowed', () => {
  const mutations = [
    body => { body.budget.identity.entityId = ''; },
    body => { body.budget.identity.entityId = 'ORG-É'; },
    body => { body.budget.identity.fiscalYearId = ' '.repeat(4); },
    body => { body.budget.responsibilities.budgetOwnerAgentId = null; },
    body => { body.budget.responsibilities.controllerAgentId = ''; },
    body => { body.budget.rows[0].dimensions.functionId = 'x'.repeat(129); },
    body => { body.budget.rows[0].dimensions.teamId = 2; }
  ];
  for (const mutation of mutations) rejects(mutation);

  const body = createBody();
  body.budget.responsibilities.controllerAgentId = 'controller-id';
  for (const key of Object.keys(body.budget.rows[0].dimensions)) {
    body.budget.rows[0].dimensions[key] = null;
  }
  assert.doesNotThrow(() => validateBudgetV2CreateBody(body));
});

test('rows require unique nonempty ids, bounded labels and retained enumerations', () => {
  rejects(body => { body.budget.rows.push(row('row-1')); });
  rejects(body => { body.budget.rows[0].id = ' '; });
  rejects(body => { body.budget.rows[0].id = 'x'.repeat(65); });
  rejects(body => { body.budget.rows[0].label = ''; });
  rejects(body => { body.budget.rows[0].label = 'x'.repeat(121); });
  rejects(body => { body.budget.rows[0].kind = 'personal'; });
  rejects(body => { body.budget.rows[0].direction = 'neutral'; });
  rejects(body => { body.budget.rows[0].currency = 'EUR'; });
  rejects(body => { body.budget.rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => row(`row-${i}`)); });
});

test('periods are explicit, exactly twelve and unique without positional normalization', () => {
  rejects(body => { body.budget.rows[0].periodValues.pop(); });
  rejects(body => { body.budget.rows[0].periodValues.push({ periodId: 'P13', value: '' }); });
  rejects(body => { body.budget.rows[0].periodValues[1].periodId = body.budget.rows[0].periodValues[0].periodId; });
  rejects(body => { body.budget.rows[0].periodValues[0].periodId = null; });

  const body = createBody();
  body.budget.rows[0].periodValues.reverse();
  assert.doesNotThrow(() => validateBudgetV2CreateBody(body));
});

test('amount values distinguish missing and zero and reject invalid numeric forms', () => {
  const valid = ['', '0', '0,00', '1000000000', '12.34'];
  for (const value of valid) {
    const body = createBody();
    body.budget.rows[0].periodValues[0].value = value;
    assert.doesNotThrow(() => validateBudgetV2CreateBody(body));
  }
  const invalid = [0, -1, '-1', ' 0', '0 ', '1 000', '1e3', '0.001', '1000000000.01', 'NaN'];
  for (const value of invalid) rejects(body => { body.budget.rows[0].periodValues[0].value = value; });
});

test('rate triplet is either exactly empty or complete, positive and source-backed', () => {
  const mutations = [
    body => { body.budget.rate = ''; },
    body => { body.budget.rateSource = ''; },
    body => { body.budget.rateDate = ''; },
    body => { body.budget.rate = '0'; },
    body => { body.budget.rate = ' 710'; },
    body => { body.budget.rate = '1e3'; },
    body => { body.budget.rate = '1.0000001'; },
    body => { body.budget.rateSource = ' Source'; },
    body => { body.budget.rateDate = '2026-02-30'; }
  ];
  for (const mutation of mutations) rejects(mutation);
});

test('standalone budget validation is pure and V1 shapes are rejected by V2 envelopes', () => {
  const candidate = budget();
  assert.equal(validateBudgetV2(candidate), candidate);
  assert.throws(() => validateBudgetV2CreateBody({
    contractVersion: 2,
    budget: { title: 'V1', entity: '2SG', year: '2027', revision: 0, rate: '', rateSource: '', rateDate: '', rows: [] }
  }), BudgetV2ContractError);
});

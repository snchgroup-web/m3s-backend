const test = require('node:test');
const assert = require('node:assert/strict');
const { BigQuery } = require('@google-cloud/bigquery');
const { columns, supportsIncomeAmounts, incomeAmountParams, incomeQueryParams,
  maskIncompleteIncomeTotals, planIncomeAmountMigration } = require('../financeIncomeStorage');
const { maskIncompleteExpenseTotals } = require('../financeExpenseStorage');
const { normalizeFinanceTransaction } = require('../financeTransaction');
const baseSchema = ['MONTANT_SAISI', 'MONTANT_CHF', 'MONTANT_CFA', 'TAUX_FX_SAISI', 'TAUX_FX_APPLIQUE', 'TAUX_REF_AUTO']
  .map(name => ({ name, type: 'FLOAT', mode: 'NULLABLE' }));
baseSchema.push({ name: 'DEVISE_SAISIE', type: 'STRING', mode: 'NULLABLE' });
baseSchema.push({ name: 'DEVISE_CIBLE', type: 'STRING', mode: 'NULLABLE' });
const schema = [...baseSchema, ...Object.entries(columns).map(([name, type]) => ({ name, type, mode: 'NULLABLE' }))];
const body = { amount_contract_version: 2, source_amounts: { original_currency: 'CHF', total_received: '2.50' } };

test('nullable BigQuery parameters are explicitly typed and serialize offline', () => {
  const row = incomeAmountParams(body);
  assert.equal(row.montant_chf, 2.5);
  assert.equal(row.montant_cfa, null);
  assert.equal(row.taux_fx_applique, null);
  const { params, types } = incomeQueryParams(row);
  for (const [name, value] of Object.entries(params)) {
    if (value === null) assert.ok(types[name]);
    assert.doesNotThrow(() => BigQuery.valueToQueryParameter_(value, types[name]));
  }
});
test('no unsupported version or implicit reference rate', () => {
  for (const version of [undefined, 1, 3, '2']) assert.throws(() => incomeAmountParams({ ...body, amount_contract_version: version }));
  const row = incomeAmountParams({ ...body, source_amounts: { ...body.source_amounts, equivalent_cfa: 1700, conversion_source: 'Synthetic' } });
  assert.equal(row.taux_fx_applique, 680);
  assert.equal(row.taux_fx_reference, null);
});
test('schema gate requires nullable amounts, rates and source metadata', () => {
  assert.equal(supportsIncomeAmounts(schema), true);
  assert.equal(supportsIncomeAmounts(baseSchema), false);
  assert.equal(supportsIncomeAmounts(null), false);
  for (const name of ['MONTANT_CFA', 'TAUX_FX_APPLIQUE', 'CONVERSION_SOURCE', 'DEVISE_CIBLE']) {
    assert.equal(supportsIncomeAmounts(schema.map(field => field.name === name ? { ...field, mode: 'REQUIRED' } : field)), false);
    assert.equal(supportsIncomeAmounts(schema.filter(field => field.name !== name)), false);
  }
});
test('partial income totals stay distinct from known sums and expense totals', () => {
  const original = Object.freeze({ total_income: 5.67, total_income_cfa: 1000, income_missing_chf: 0, income_missing_cfa: 3,
    total_expenses: 10, total_expenses_cfa: 6500, expenses_missing_chf: 0, expenses_missing_cfa: 0 });
  const result = maskIncompleteIncomeTotals(maskIncompleteExpenseTotals(original));
  assert.equal(result.total_income, 5.67);
  assert.equal(result.total_income_cfa, null);
  assert.equal(result.known_income_cfa, 1000);
  assert.equal(result.total_expenses_cfa, 6500);
  assert.equal(original.total_income_cfa, 1000);
  assert.equal(maskIncompleteIncomeTotals({ total_income: 0, income_missing_chf: 0 }).total_income, 0);
  assert.equal(maskIncompleteIncomeTotals({ total_income: null, income_missing_chf: 0 }).total_income, null);
});
test('additive planner is bounded, idempotent and never executes a migration', () => {
  const input = { project: 'synthetic-project', dataset: 'finance', table: 'income', schema: baseSchema };
  const plan = planIncomeAmountMigration(input);
  assert.equal(plan.executed, false);
  assert.equal(plan.status, 'BACKUP_AND_RESTORE_VERIFICATION_REQUIRED');
  assert.deepEqual(plan.additions, ['AMOUNT_CONTRACT_VERSION', 'CONVERSION_SOURCE']);
  assert.match(plan.sql, /^ALTER TABLE `synthetic-project.finance.income`/);
  assert.doesNotMatch(plan.sql, /DROP|DELETE|UPDATE|INSERT|REPLACE/);
  assert.equal(planIncomeAmountMigration({ ...input, schema }).sql, null);
  for (const change of [{ table: 'income`; DROP TABLE x;' }, { project: '' }, { schema: [] },
    { schema: [...baseSchema, { name: 'CONVERSION_SOURCE', type: 'INTEGER' }] }]) {
    assert.throws(() => planIncomeAmountMigration({ ...input, ...change }));
  }
});
test('income normalizer retains source amounts and transaction dimensions', () => {
  const row = normalizeFinanceTransaction({ ...body, date: '2026-01-15', description: 'Synthetic refund',
    team: 'Synthetic team', agent: 'Synthetic agent', commentaire: 'Synthetic reference' }, 'QA', 'income');
  assert.equal(row.montant_chf, 2.5);
  assert.equal(row.montant_cfa, null);
  assert.equal(row.agent, 'Synthetic agent');
  assert.equal(row.commentaire, 'Synthetic reference');
  assert.equal(row.type, 'Virement');
});

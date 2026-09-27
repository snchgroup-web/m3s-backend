const test = require('node:test');
const assert = require('node:assert/strict');
const { columns, supportsExpenseAmounts, expenseQueryParams, maskIncompleteExpenseTotals } = require('../financeExpenseStorage');
const { normalizeFinanceTransaction } = require('../financeTransaction');
const base = { date: '2026-01-15', description: 'Synthetic invoice', amount_contract_version: 2,
  source_amounts: { original_currency: 'USD', total_paid: '12.34' }, team: 'Team_ZH', agent: 'Synthetic', fournisseur: 'Synthetic supplier' };
test('versioned transaction retains dimensions and unknown equivalents', () => {
  const row = normalizeFinanceTransaction(base, 'TEST', 'expense');
  assert.equal(row.montant_chf, null);
  assert.equal(row.montant_cfa, null);
  assert.equal(row.devise_origine, 'USD');
  assert.equal(row.montant_origine, 12.34);
  assert.equal(row.team, base.team);
  assert.equal(row.agent, base.agent);
  assert.equal(row.fournisseur, base.fournisseur);
  const { params, types } = expenseQueryParams(row);
  for (const [name, value] of Object.entries(params)) if (value === null) assert.ok(types[name], name);
  const { BigQuery } = require('@google-cloud/bigquery');
  for (const [name, value] of Object.entries(params)) assert.doesNotThrow(() => BigQuery.valueToQueryParameter_(value, types[name]), name);
});
test('old and incomplete schemas do not advertise support', () => {
  const schema = Object.entries(columns).map(([name, type]) => ({ name, type, mode: 'NULLABLE' }));
  assert.equal(supportsExpenseAmounts(schema), true);
  assert.equal(supportsExpenseAmounts(schema.slice(1)), false);
  assert.equal(supportsExpenseAmounts(schema.map(f => ({ ...f, mode: 'REQUIRED' }))), false);
});
test('unsupported versions and income cannot silently discard source amounts', () => {
  assert.throws(() => normalizeFinanceTransaction(base, 'TEST', 'income'));
  assert.throws(() => normalizeFinanceTransaction({ ...base, amount_contract_version: 3 }, 'TEST', 'expense'));
  assert.throws(() => normalizeFinanceTransaction({ ...base, amount_contract_version: undefined }, 'TEST', 'expense'));
});
test('all API consumers receive unavailable totals instead of incomplete sums', () => {
  const result = maskIncompleteExpenseTotals({ total_expenses: 10, total_expenses_cfa: 6500, expenses_missing_chf: 1, expenses_missing_cfa: 0 });
  assert.equal(result.total_expenses, null);
  assert.equal(result.known_expenses_chf, 10);
  assert.equal(result.total_expenses_cfa, 6500);
});

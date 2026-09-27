const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExpenseAmounts: normalize } = require('../financeExpenseAmounts');

test('CHF invoice without conversion retains unknown CFA and unknown fees', () => {
  const result = normalize({ original_currency: 'CHF', total_paid: '123.45' });
  assert.equal(result.equivalent_chf, 123.45);
  assert.equal(result.equivalent_cfa, null);
  assert.equal(result.fees, null);
  assert.equal(result.conversion_status, 'incomplete');
});
test('USD amount is never treated as CHF or silently converted', () => {
  const result = normalize({ original_currency: 'USD', total_paid: '12.34' });
  assert.equal(result.total_paid, 12.34);
  assert.equal(result.equivalent_chf, null);
  assert.equal(result.equivalent_cfa, null);
});
test('recipient amount remains distinct from accounting equivalents', () => {
  const result = normalize({ original_currency: 'CHF', total_paid: '102.50', principal: '100', fees: '2.50', recipient_currency: 'CFA', recipient_amount: '65000' });
  assert.equal(result.recipient_currency, 'XOF');
  assert.equal(result.recipient_amount, 65000);
  assert.equal(result.equivalent_chf, 102.5);
  assert.equal(result.equivalent_cfa, null);
});
test('explicit zero fees differ from unknown fees', () => {
  assert.equal(normalize({ original_currency: 'EUR', total_paid: '1', principal: '1', fees: '0' }).fees, 0);
});
test('decimal totals use minor units without floating point sum errors', () => {
  assert.equal(normalize({ original_currency: 'CHF', total_paid: '0.30', principal: '0.10', fees: '0.20' }).total_paid, 0.3);
});
test('documented equivalents are retained without using recipient amounts', () => {
  const result = normalize({ original_currency: 'USD', total_paid: '10', equivalent_chf: '8.90', equivalent_cfa: '5800', conversion_source: 'Synthetic bank reference' });
  assert.equal(result.conversion_status, 'complete');
  assert.equal(result.equivalent_chf, 8.9);
  assert.equal(result.equivalent_cfa, 5800);
});
test('CFA source amount maps only to its own equivalent', () => {
  const result = normalize({ original_currency: 'CFA', total_paid: '1000' });
  assert.equal(result.equivalent_cfa, 1000);
  assert.equal(result.equivalent_chf, null);
});
for (const amount of ['12oops', '1,20', '-1', '1.001', '1e2', Infinity, NaN, true, [], {}, ' ', '9007199254740992']) {
  test(`reject invalid CHF amount ${String(amount)}`, () => assert.throws(() => normalize({ original_currency: 'CHF', total_paid: amount })));
}
for (const [name, fields] of [
  ['zero total', { total_paid: 0 }],
  ['unsupported currency', { original_currency: 'BTC' }],
  ['incomplete fee breakdown', { principal: 1 }],
  ['mismatched fee breakdown', { principal: 8, fees: 1 }],
  ['recipient currency alone', { recipient_currency: 'XOF' }],
  ['recipient amount alone', { recipient_amount: 100 }],
  ['fractional XOF', { recipient_currency: 'XOF', recipient_amount: '100.50' }],
  ['invented original equivalent', { equivalent_chf: 9 }],
  ['unattributed conversion', { equivalent_cfa: 6500 }],
  ['zero equivalent', { equivalent_cfa: 0, conversion_source: 'Synthetic' }],
  ['source without conversion', { conversion_source: 'Synthetic' }],
]) {
  test(name, () => assert.throws(() => normalize({ original_currency: 'CHF', total_paid: 10, ...fields })));
}
test('normalization does not mutate input or carry unrelated fields', () => {
  const input = Object.freeze({ original_currency: 'CHF', total_paid: 10, project_id: 'synthetic' });
  assert.equal(normalize(input).project_id, undefined);
  assert.equal(input.total_paid, 10);
});

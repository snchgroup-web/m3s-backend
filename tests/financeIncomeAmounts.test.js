const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIncomeAmounts: normalize } = require('../financeIncomeAmounts');

test('three synthetic CHF credits retain missing CFA without aggregating equal amounts', () => {
  const rows = ['1.62', '2.43', '1.62'].map(total_received => normalize({ original_currency: 'CHF', total_received }));
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((sum, row) => sum + Math.round(row.total_received * 100), 0), 567);
  for (const row of rows) {
    assert.equal(row.equivalent_chf, row.total_received);
    assert.equal(row.equivalent_cfa, null);
    assert.equal(row.conversion_source, null);
    assert.equal(row.conversion_status, 'incomplete');
  }
});

test('documented equivalent does not change the received amount or input', () => {
  const input = Object.freeze({ original_currency: 'CHF', total_received: '2.50', equivalent_cfa: '1700', conversion_source: 'Synthetic conversion evidence' });
  assert.deepEqual(normalize(input), { original_currency: 'CHF', total_received: 2.5,
    equivalent_chf: 2.5, equivalent_cfa: 1700, conversion_source: input.conversion_source, conversion_status: 'complete' });
});

test('foreign receipt is not silently treated as CHF and CFA aliases XOF', () => {
  assert.equal(normalize({ original_currency: 'USD', total_received: 5 }).equivalent_chf, null);
  assert.equal(normalize({ original_currency: 'CFA', total_received: 500 }).equivalent_cfa, 500);
});

for (const total_received of [0, -1, '1.001', '1e2', '1,62', NaN, Infinity, true, {}, [], null, '']) {
  test(`rejects invalid received amount ${String(total_received)}`, () => {
    assert.throws(() => normalize({ original_currency: 'CHF', total_received }));
  });
}
for (const fields of [{ fees: 0 }, { total_paid: 2 }, { recipient_amount: 10 },
  { equivalent_cfa: 0 }, { equivalent_cfa: 1000 }, { equivalent_chf: 3 },
  { original_currency: 'BTC' }, { conversion_source: 'No conversion' }]) {
  test(`rejects incompatible income fields ${JSON.stringify(fields)}`, () => {
    assert.throws(() => normalize({ original_currency: 'CHF', total_received: 2, ...fields }));
  });
}
test('requires an amount object', () => {
  for (const input of [null, undefined, [], '2']) assert.throws(() => normalize(input));
});

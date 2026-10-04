const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFxRateMetadata } = require('../fxRateMetadata');

const rows = [
  { devise_base: 'CHF', devise_cible: 'CFA', taux: 700, date_taux: { value: '2026-10-03' }, source_taux: 'Synthetic provider' },
  { devise_base: 'CHF', devise_cible: 'CFA', taux: 690, date_taux: '2026-10-02', source_taux: 'Previous synthetic provider' }
];

test('preserves last-row selection of the current view and never mutates input', () => {
  const original = JSON.stringify(rows);
  assert.deepEqual(buildFxRateMetadata(rows, 'current_view').CHF_CFA, {
    rate: 690, date: '2026-10-02', source: 'Previous synthetic provider', basis: 'current_view'
  });
  assert.equal(JSON.stringify(rows), original);
});

test('historical fallback retains the first selected row and BigQuery date', () => {
  assert.deepEqual(buildFxRateMetadata(rows, 'history_fallback').CHF_CFA, {
    rate: 700, date: '2026-10-03', source: 'Synthetic provider', basis: 'history_fallback'
  });
});

test('supports legacy aliases without inventing a source', () => {
  assert.deepEqual(buildFxRateMetadata([{ source_currency: 'CHF', target_currency: 'CFA', rate: '710', date_updated: '2026-09-29' }], 'history_fallback').CHF_CFA, {
    rate: 710, date: '2026-09-29', source: null, basis: 'history_fallback'
  });
});

test('historical fallback skips a falsy rate just like the existing rate selector', () => {
  assert.equal(buildFxRateMetadata([{ ...rows[0], taux: 0 }, rows[1]], 'history_fallback').CHF_CFA.rate, 690);
  assert.equal(buildFxRateMetadata([{ ...rows[0], taux: -1 }, rows[1]], 'history_fallback').CHF_CFA.rate, null);
});

test('invalid rates and invalid dates remain unknown, not zero or today', () => {
  for (const taux of [null, 0, -1, 'invalid', Infinity]) {
    assert.equal(buildFxRateMetadata([{ devise_base: 'CHF', devise_cible: 'CFA', taux, date_taux: '2026-02-30' }], 'current_view').CHF_CFA.rate, null);
  }
  for (const date_taux of [null, '2026-02-30', '03.10.2026', '2026-10-03junk']) {
    assert.equal(buildFxRateMetadata([{ devise_base: 'CHF', devise_cible: 'CFA', taux: 700, date_taux }], 'current_view').CHF_CFA.date, null);
  }
  assert.deepEqual(buildFxRateMetadata([], 'current_view'), {});
});

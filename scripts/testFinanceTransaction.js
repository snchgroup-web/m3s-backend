const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeFinanceTransaction } = require('../financeTransaction');

const base = {
  date: '2026-08-22',
  description: 'Recette test',
  montant_origine: 100,
  devise_origine: 'CHF',
  montant_chf: 100,
  montant_cfa: 71000,
};

const legacy = normalizeFinanceTransaction({ ...base, taux_fx: 705 }, 'REC-TEST-1', 'income');
assert.strictEqual(legacy.taux_fx, 705);
assert.strictEqual(legacy.taux_fx_applique, 705);
assert.strictEqual(legacy.taux_fx_reference, 0);

const distinct = normalizeFinanceTransaction({
  ...base,
  taux_fx_applique: 705,
  taux_fx_reference: 710,
}, 'REC-TEST-2', 'income');
assert.strictEqual(distinct.taux_fx_applique, 705);
assert.strictEqual(distinct.taux_fx_reference, 710);
assert.notStrictEqual(distinct.taux_fx_applique, distinct.taux_fx_reference);

assert.throws(
  () => normalizeFinanceTransaction({ ...base, taux_fx_reference: 710 }, 'REC-TEST-3', 'income'),
  /taux applique exact/
);

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const createIncomeRoute = serverSource.slice(
  serverSource.indexOf("app.post('/api/finance/income'"),
  serverSource.indexOf("app.put('/api/finance/income/:id'")
);
const updateIncomeRoute = serverSource.slice(
  serverSource.indexOf("app.put('/api/finance/income/:id'"),
  serverSource.indexOf("app.delete('/api/finance/income/:id'")
);

for (const route of [createIncomeRoute, updateIncomeRoute]) {
  assert.ok(route.includes('@taux_fx_applique'), 'Applied rate must have its own BigQuery parameter');
  assert.ok(route.includes('@taux_fx_reference'), 'Reference rate must have its own BigQuery parameter');
  assert.ok(!route.includes('TAUX_REF_AUTO=@taux_fx'), 'Reference rate must not reuse the applied rate');
}

console.log('Finance transaction FX contract tests passed.');

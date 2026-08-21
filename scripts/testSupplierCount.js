const assert = require('assert');
const {
  buildSupplierCountQuery,
  normalizeSupplierCount
} = require('../supplierCount');

const query = buildSupplierCountQuery({
  financeExpensesTable: '`project-test.dataset_test.expenses`',
  stockAssetsTable: '`project-test.dataset_test.stocks_actifs_propres`'
});

assert.match(query, /COUNT\(DISTINCT UPPER\(supplier\)\) AS total/);
assert.match(query, /NULLIF\(TRIM\(CAST\(FOURNISSEUR AS STRING\)\), ''\)/);
assert.match(query, /NULLIF\(TRIM\(CAST\(fournisseur AS STRING\)\), ''\)/);
assert.match(query, /UNION ALL/);
assert.equal(normalizeSupplierCount('79'), 79);
assert.equal(normalizeSupplierCount(0), 0);
assert.throws(() => normalizeSupplierCount(null), /Invalid supplier count/);
assert.throws(() => normalizeSupplierCount(-1), /Invalid supplier count/);
assert.throws(
  () => buildSupplierCountQuery({
    financeExpensesTable: '`project.dataset.expenses`; DROP TABLE x',
    stockAssetsTable: '`project.dataset.stocks_actifs_propres`'
  }),
  /Invalid BigQuery Finance expenses table reference/
);

console.log('Supplier count tests passed.');

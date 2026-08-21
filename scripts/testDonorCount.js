const assert = require('assert');
const {
  buildDonationCandidateExpression,
  buildDonorCountQuery,
  normalizeDonorCount
} = require('../donorCount');

const query = buildDonorCountQuery({
  stockAssetsTable: '`project-test.dataset_test.stocks_actifs_propres`'
});

assert.match(query, /COUNT\(DISTINCT UPPER\(donor\)\)/);
assert.match(query, /NULLIF\(TRIM\(CAST\(fournisseur AS STRING\)\), ''\)/);
assert.match(query, /REGEXP_CONTAINS/);
assert.match(query, /commentaires/);
assert.match(buildDonationCandidateExpression(), /r'\(don\|donateur\|donation\|nature\|social\)'/);
assert.throws(
  () => buildDonorCountQuery({ stockAssetsTable: 'project.dataset.table' }),
  /Invalid BigQuery Stock & Assets table reference/
);

assert.strictEqual(normalizeDonorCount(0), 0);
assert.strictEqual(normalizeDonorCount('12'), 12);
assert.throws(() => normalizeDonorCount(null), /Invalid donor count/);
assert.throws(() => normalizeDonorCount(-1), /Invalid donor count/);
assert.throws(() => normalizeDonorCount(1.5), /Invalid donor count/);

console.log('Donor count tests passed');

const assert = require('assert');
const {
  buildBeneficiaryCountQuery,
  normalizeBeneficiaryCount
} = require('../beneficiaryCount');

const query = buildBeneficiaryCountQuery({
  financeIncomeTable: '`project-test.dataset_test.income`'
});

assert.match(query, /COUNT\(DISTINCT UPPER\(beneficiary\)\) AS total/);
assert.match(query, /NULLIF\(TRIM\(CAST\(CLIENT_BENEFICIAIRE AS STRING\)\), ''\)/);
assert.match(query, /AIDE SOCIALE MENAGE/);
assert.equal(normalizeBeneficiaryCount('4'), 4);
assert.equal(normalizeBeneficiaryCount(0), 0);
assert.throws(() => normalizeBeneficiaryCount(null), /Invalid beneficiary count/);
assert.throws(() => normalizeBeneficiaryCount(-1), /Invalid beneficiary count/);
assert.throws(
  () => buildBeneficiaryCountQuery({
    financeIncomeTable: '`project.dataset.income`; DROP TABLE x'
  }),
  /Invalid BigQuery Finance income table reference/
);

console.log('Beneficiary count tests passed.');

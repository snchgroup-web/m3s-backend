const assert = require('assert');
const {
  buildBeneficiarySourceExpression,
  buildBeneficiaryCountQuery,
  normalizeBeneficiaryCount
} = require('../beneficiaryCount');

const query = buildBeneficiaryCountQuery({
  financeIncomeTable: '`project-test.dataset_test.income`'
});

assert.match(query, /COUNT\(DISTINCT UPPER\(beneficiary\)\) AS total/);
assert.match(query, /NULLIF\(TRIM\(CAST\(CLIENT_BENEFICIAIRE AS STRING\)\), ''\)/);
assert.match(query, /AIDE SOCIALE MENAGE/);
assert.equal(
  buildBeneficiarySourceExpression(),
  "NULLIF(TRIM(CAST(CLIENT_BENEFICIAIRE AS STRING)), '')"
);
assert.throws(() => buildBeneficiarySourceExpression('CLIENT; DROP'), /Invalid beneficiary source column/);
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

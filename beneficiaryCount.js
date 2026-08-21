const { socialIncomePredicate } = require('./financeDataScope');

const validateTableReference = (value) => {
  const reference = String(value || '').trim();
  if (!/^`[A-Za-z0-9_-]+\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*`$/.test(reference)) {
    throw new Error('Invalid BigQuery Finance income table reference');
  }
  return reference;
};

const buildBeneficiaryCountQuery = ({ financeIncomeTable }) => {
  const income = validateTableReference(financeIncomeTable);

  return `
    WITH beneficiary_units AS (
      SELECT NULLIF(TRIM(CAST(CLIENT_BENEFICIAIRE AS STRING)), '') AS beneficiary
      FROM ${income}
      WHERE ${socialIncomePredicate('NATURE_RECETTE')}
    )
    SELECT COUNT(DISTINCT UPPER(beneficiary)) AS total
    FROM beneficiary_units
    WHERE beneficiary IS NOT NULL
  `;
};

const normalizeBeneficiaryCount = value => {
  if (value === null || value === undefined || value === '') {
    throw new Error('Invalid beneficiary count returned by BigQuery');
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Invalid beneficiary count returned by BigQuery');
  }
  return count;
};

module.exports = {
  buildBeneficiaryCountQuery,
  normalizeBeneficiaryCount
};

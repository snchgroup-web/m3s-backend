const validateTableReference = (value) => {
  const reference = String(value || '').trim();
  if (!/^`[A-Za-z0-9_-]+\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*`$/.test(reference)) {
    throw new Error('Invalid BigQuery Stock & Assets table reference');
  }
  return reference;
};

const buildDonationCandidateExpression = () => `
  REGEXP_CONTAINS(
    LOWER(CONCAT(
      COALESCE(CAST(article AS STRING), ''), ' ',
      COALESCE(CAST(categorie AS STRING), ''), ' ',
      COALESCE(CAST(sous_categorie AS STRING), ''), ' ',
      COALESCE(CAST(fournisseur AS STRING), ''), ' ',
      COALESCE(CAST(localisation AS STRING), ''), ' ',
      COALESCE(CAST(bu AS STRING), ''), ' ',
      COALESCE(CAST(commentaires AS STRING), ''), ' ',
      COALESCE(CAST(statut AS STRING), '')
    )),
    r'(don|donateur|donation|nature|social)'
  )
`;

const buildDonorCountQuery = ({ stockAssetsTable }) => {
  const stockAssets = validateTableReference(stockAssetsTable);

  return `
    WITH identified_donors AS (
      SELECT NULLIF(TRIM(CAST(fournisseur AS STRING)), '') AS donor
      FROM ${stockAssets}
      WHERE ${buildDonationCandidateExpression()}
    )
    SELECT COUNT(DISTINCT UPPER(donor)) AS total
    FROM identified_donors
    WHERE donor IS NOT NULL
  `;
};

const normalizeDonorCount = value => {
  if (value === null || value === undefined || value === '') {
    throw new Error('Invalid donor count returned by BigQuery');
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Invalid donor count returned by BigQuery');
  }
  return count;
};

module.exports = {
  buildDonationCandidateExpression,
  buildDonorCountQuery,
  normalizeDonorCount
};

const validateTableReference = (value, label) => {
  const reference = String(value || '').trim();
  if (!/^`[A-Za-z0-9_-]+\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*`$/.test(reference)) {
    throw new Error(`Invalid BigQuery ${label} table reference`);
  }
  return reference;
};

const buildSupplierCountQuery = ({ financeExpensesTable, stockAssetsTable }) => {
  const expenses = validateTableReference(financeExpensesTable, 'Finance expenses');
  const stockAssets = validateTableReference(stockAssetsTable, 'Stock & Assets');

  return `
    WITH supplier_names AS (
      SELECT NULLIF(TRIM(CAST(FOURNISSEUR AS STRING)), '') AS supplier
      FROM ${expenses}
      UNION ALL
      SELECT NULLIF(TRIM(CAST(fournisseur AS STRING)), '') AS supplier
      FROM ${stockAssets}
    )
    SELECT COUNT(DISTINCT UPPER(supplier)) AS total
    FROM supplier_names
    WHERE supplier IS NOT NULL
  `;
};

const normalizeSupplierCount = value => {
  if (value === null || value === undefined || value === '') {
    throw new Error('Invalid supplier count returned by BigQuery');
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Invalid supplier count returned by BigQuery');
  }
  return count;
};

module.exports = {
  buildSupplierCountQuery,
  normalizeSupplierCount
};

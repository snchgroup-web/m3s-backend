function hasExpectedBigQueryTableContract(metadata, contract) {
  const actualFields = metadata?.schema?.fields;
  if (!Array.isArray(actualFields) || actualFields.length !== contract.fields.length) return false;
  const fieldsMatch = contract.fields.every((expected, index) => {
    const actual = actualFields[index];
    return actual?.name === expected.name
      && String(actual.type || '').toUpperCase() === expected.type
      && String(actual.mode || 'NULLABLE').toUpperCase() === expected.mode;
  });
  if (!fieldsMatch) return false;

  const partitioning = metadata?.timePartitioning;
  if (contract.partitionField) {
    if (String(partitioning?.type || '').toUpperCase() !== 'DAY'
      || partitioning?.field !== contract.partitionField) return false;
  } else if (partitioning) {
    return false;
  }

  const actualClustering = metadata?.clustering?.fields || [];
  return actualClustering.length === contract.clustering.length
    && contract.clustering.every((field, index) => actualClustering[index] === field);
}

async function assertBigQueryTableContract(table, contract, code) {
  let metadata;
  try {
    [metadata] = await table.getMetadata();
  } catch {
    const error = new Error('BigQuery table metadata is unavailable');
    error.code = code;
    throw error;
  }
  if (hasExpectedBigQueryTableContract(metadata, contract)) return;
  const error = new Error('BigQuery table schema is invalid');
  error.code = code;
  throw error;
}

module.exports = { hasExpectedBigQueryTableContract, assertBigQueryTableContract };

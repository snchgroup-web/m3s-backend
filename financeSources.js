const normalizeIdentifier = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9]/g, '')
  .toUpperCase();

const SOURCE_DEFINITIONS = {
  income: {
    envName: 'BIGQUERY_FINANCE_INCOME_TABLE',
    candidates: ['income', 'recettes', 'revenus', 'finance_income', 'finance_recettes', 'income_propres'],
    requiredFields: ['ID_RECETTE', 'MONTANT_CHF', 'MONTANT_CFA', 'NATURE_RECETTE', 'DATE']
  },
  expenses: {
    envName: 'BIGQUERY_FINANCE_EXPENSES_TABLE',
    candidates: ['expenses', 'depenses', 'finance_expenses', 'finance_depenses', 'expenses_propres'],
    requiredFields: ['Nr REF', 'CHF', 'CFA', 'RUBRIQUE DEP', 'DATE']
  }
};

const safeTableName = value => {
  const tableName = String(value || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
    throw new Error(`Nom de table Finance invalide: ${tableName || '(vide)'}`);
  }
  return tableName;
};

const hasRequiredFields = (fields, requiredFields) => {
  const available = new Set(fields.map(field => normalizeIdentifier(field.name)));
  return requiredFields.every(field => available.has(normalizeIdentifier(field)));
};

const resolveFinanceSources = async ({ bigquery, datasetId, configured = {} }) => {
  const dataset = bigquery.dataset(datasetId);
  const [[datasetMetadata], [tables]] = await Promise.all([
    dataset.getMetadata(),
    dataset.getTables()
  ]);
  const tableNames = tables.map(table => safeTableName(table.id));
  const tableByNormalizedName = new Map(
    tableNames.map(tableName => [normalizeIdentifier(tableName), tableName])
  );
  const metadataCache = new Map();

  const readFields = async tableName => {
    if (!metadataCache.has(tableName)) {
      const [metadata] = await dataset.table(tableName).getMetadata();
      metadataCache.set(tableName, metadata.schema?.fields || []);
    }
    return metadataCache.get(tableName);
  };

  const resolved = {};
  for (const [sourceKey, definition] of Object.entries(SOURCE_DEFINITIONS)) {
    const configuredName = configured[sourceKey]
      || process.env[definition.envName]
      || '';
    const preferredNames = [configuredName, ...definition.candidates].filter(Boolean);
    let tableName = preferredNames
      .map(candidate => tableByNormalizedName.get(normalizeIdentifier(candidate)))
      .find(Boolean);

    if (!tableName) {
      for (const candidate of tableNames) {
        if (Object.values(resolved).includes(candidate)) continue;
        try {
          const fields = await readFields(candidate);
          if (hasRequiredFields(fields, definition.requiredFields)) {
            tableName = candidate;
            break;
          }
        } catch (error) {
          console.warn(`Finance source schema skipped for ${candidate}: ${error.message}`);
        }
      }
    }

    if (!tableName) {
      const error = new Error(`Source Finance ${sourceKey} introuvable dans le dataset ${datasetId}`);
      error.code = 'FINANCE_SOURCE_TABLE_MISSING';
      error.sourceKey = sourceKey;
      throw error;
    }

    resolved[sourceKey] = tableName;
  }

  return {
    ...resolved,
    location: String(datasetMetadata.location || '').trim() || null
  };
};

module.exports = {
  SOURCE_DEFINITIONS,
  hasRequiredFields,
  normalizeIdentifier,
  resolveFinanceSources,
  safeTableName
};

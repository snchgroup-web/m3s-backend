const assert = require('assert');
const { resolveFinanceSources } = require('../financeSources');

const schemas = {
  recettes_archive: ['ID_RECETTE', 'MONTANT_CHF', 'MONTANT_CFA', 'NATURE_RECETTE', 'DATE'],
  depenses_legacy: ['Nr REF', 'CHF', 'CFA', 'RUBRIQUE DEP', 'DATE'],
  unrelated: ['id', 'label']
};

const fakeBigQuery = tableNames => ({
  dataset: () => ({
    getMetadata: async () => [{ location: 'EU' }],
    getTables: async () => [tableNames.map(id => ({ id }))],
    table: tableName => ({
      getMetadata: async () => [{ schema: { fields: (schemas[tableName] || []).map(name => ({ name })) } }]
    })
  })
});

(async () => {
  const sources = await resolveFinanceSources({
    bigquery: fakeBigQuery(['unrelated', 'recettes_archive', 'depenses_legacy']),
    datasetId: 'm3s_2sg'
  });
  assert.deepStrictEqual(sources, {
    income: 'recettes_archive',
    expenses: 'depenses_legacy',
    location: 'EU'
  });

  const exactSources = await resolveFinanceSources({
    bigquery: fakeBigQuery(['income', 'expenses']),
    datasetId: 'm3s_2sg'
  });
  assert.strictEqual(exactSources.income, 'income');
  assert.strictEqual(exactSources.expenses, 'expenses');

  await assert.rejects(
    () => resolveFinanceSources({
      bigquery: fakeBigQuery(['unrelated']),
      datasetId: 'm3s_2sg'
    }),
    error => error.code === 'FINANCE_SOURCE_TABLE_MISSING'
  );

  console.log('Finance source resolution tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

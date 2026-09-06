const { ensureAdministrationRegistrySchema } = require('./administrationRegistries');
const { ensureManagementPortfolio } = require('./managementPortfolio');
const { ensureIntelligenceDashboardSchema } = require('./intelligenceDashboard');

const identifier = (value, label, pattern) => {
  const normalized = String(value || '').trim();
  if (!pattern.test(normalized)) throw new Error(`Invalid BigQuery ${label}`);
  return normalized;
};

function buildFinanceSchemaStatements({ projectId, datasetId, incomeTable, expensesTable }) {
  const project = identifier(projectId, 'project identifier', /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  const dataset = identifier(datasetId, 'dataset identifier', /^[A-Za-z_][A-Za-z0-9_]*$/);
  const income = identifier(incomeTable, 'income table identifier', /^[A-Za-z0-9_]+$/);
  const expenses = identifier(expensesTable, 'expenses table identifier', /^[A-Za-z0-9_]+$/);
  const table = name => `\`${project}.${dataset}.${name}\``;
  return [
    `ALTER TABLE ${table(expenses)} ADD COLUMN IF NOT EXISTS TEAM STRING`,
    `ALTER TABLE ${table(expenses)} ADD COLUMN IF NOT EXISTS DEPARTEMENT STRING`,
    `ALTER TABLE ${table(income)} ADD COLUMN IF NOT EXISTS DEPARTEMENT STRING`
  ];
}

async function runIndependentSchemaMigrations({
  bigquery,
  projectId,
  datasetId,
  location = 'US',
  tenantId = '2sg'
}) {
  const results = {};
  results.administration = await ensureAdministrationRegistrySchema({ bigquery, projectId, datasetId, location });
  results.management = await ensureManagementPortfolio({ bigquery, projectId, datasetId, location, tenantId });
  results.intelligence = await ensureIntelligenceDashboardSchema({ bigquery, datasetId, location });
  return results;
}

async function runFinanceSchemaMigrations({ bigquery, projectId, datasetId, location = 'US', financeSources }) {
  if (!financeSources?.income || !financeSources?.expenses) {
    throw new Error('Resolved Finance sources are required for schema migration');
  }
  const financeStatements = buildFinanceSchemaStatements({
    projectId,
    datasetId,
    incomeTable: financeSources.income,
    expensesTable: financeSources.expenses
  });
  for (const query of financeStatements) await bigquery.query({ query, location });
  return { statements: financeStatements.length };
}

async function runApplicationSchemaMigrations(options) {
  const results = await runIndependentSchemaMigrations(options);
  results.finance = await runFinanceSchemaMigrations(options);
  return results;
}

module.exports = {
  buildFinanceSchemaStatements,
  runIndependentSchemaMigrations,
  runFinanceSchemaMigrations,
  runApplicationSchemaMigrations
};

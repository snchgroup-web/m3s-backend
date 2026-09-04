const { buildBudgetSchemaStatements } = require('../financeBudgetDrafts');

const [projectId, datasetId, ...extra] = process.argv.slice(2);
if (!projectId || !datasetId || extra.length) {
  console.error('Usage: node scripts/printBudgetSchema.js PROJECT_ID DATASET_ID (prints SQL only)');
  process.exitCode = 1;
} else {
  try {
    console.log('-- Review and apply only to an explicitly approved environment. No SQL is executed by this script.');
    console.log(buildBudgetSchemaStatements({ projectId, datasetId }).join(';\n\n') + ';');
  } catch {
    console.error('Invalid BigQuery project or dataset identifier. No SQL generated.');
    process.exitCode = 1;
  }
}

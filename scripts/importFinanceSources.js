#!/usr/bin/env node

const { BigQuery } = require('@google-cloud/bigquery');
const fs = require('fs');

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const apply = args.includes('--apply');
const projectId = option('--project', process.env.GOOGLE_CLOUD_PROJECT || 'mon-projet-data-2sg');
const datasetId = option('--dataset', process.env.BIGQUERY_DATASET || 'm3s_2sg');
const keyFilename = option('--credentials', process.env.GOOGLE_APPLICATION_CREDENTIALS);
const inputFilename = option('--input');

const incomeSchema = [
  ['ID_RECETTE', 'STRING'], ['DATE', 'DATE'], ['DESIGNATION', 'STRING'],
  ['MONTANT_SAISI', 'FLOAT64'], ['DEVISE_SAISIE', 'STRING'], ['MONTANT_CHF', 'FLOAT64'],
  ['MONTANT_CFA', 'FLOAT64'], ['MODE_ENCAISSEMENT', 'STRING'], ['TYPE_BUDGETAIRE', 'STRING'],
  ['NATURE_RECETTE', 'STRING'], ['MODE_TAUX', 'STRING'], ['PERIODE_REF', 'STRING'],
  ['TAUX_REF_AUTO', 'FLOAT64'], ['TAUX_FX_SAISI', 'FLOAT64'], ['TAUX_FX_APPLIQUE', 'FLOAT64'],
  ['DEVISE_CIBLE', 'STRING'], ['SENS_TRESORERIE', 'STRING'], ['BU', 'STRING'],
  ['DEPARTEMENT', 'STRING'], ['PHASE', 'STRING'], ['SOUS_PHASE', 'STRING'], ['TEAM', 'STRING'],
  ['AGENT', 'STRING'], ['CLIENT_BENEFICIAIRE', 'STRING'], ['TYPE_CB', 'STRING'], ['PAYS', 'STRING'],
  ['LIEN_PIECE', 'STRING'], ['COMMENTAIRE', 'STRING'], ['Année', 'INTEGER'],
  ['SOURCE_FILE', 'STRING'], ['SOURCE_SHEET', 'STRING'], ['SOURCE_ROW', 'INTEGER']
].map(([name, type]) => ({ name, type, mode: 'NULLABLE' }));

const expenseSchema = [
  ['Nr REF', 'STRING'], ['DATE', 'DATE'], ['DESIGNATION', 'STRING'], ['CHF', 'FLOAT64'],
  ['CFA', 'FLOAT64'], ['PAIEMENT', 'STRING'], ['POSTE  ', 'STRING'], ['OPERATION ', 'STRING'],
  ['RUBRIQUE DEP', 'STRING'], ['BU', 'STRING'], ['DEPARTEMENT', 'STRING'], ['TEAM', 'STRING'],
  ['PHASE', 'STRING'], [' AGENT', 'STRING'], ['FOURNISSEUR', 'STRING'], ['PAYS', 'STRING'],
  ['COMMENTAIRES', 'STRING'], ['SOURCE_FILE', 'STRING'], ['SOURCE_SHEET', 'STRING'], ['SOURCE_ROW', 'INTEGER']
].map(([name, type]) => ({ name, type, mode: 'NULLABLE' }));

const readStdin = async () => {
  if (inputFilename) return JSON.parse(fs.readFileSync(inputFilename, 'utf8'));
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
};

const closeEnough = (actual, expected) => Math.abs(Number(actual || 0) - Number(expected || 0)) < 0.01;

const verifyPayload = (payload) => {
  const { metadata, income, expenses } = payload;
  if (!metadata || !Array.isArray(income) || !Array.isArray(expenses)) throw new Error('Invalid Finance payload.');
  if (income.length !== metadata.income_count || expenses.length !== metadata.expense_count) {
    throw new Error('Payload counts do not match extraction metadata.');
  }
  const uniqueIncome = new Set(income.map((row) => row.ID_RECETTE));
  const uniqueExpenses = new Set(expenses.map((row) => row['Nr REF']));
  if (uniqueIncome.size !== income.length || uniqueExpenses.size !== expenses.length) {
    throw new Error('Duplicate Finance identifiers detected.');
  }
};

const querySummary = async (bigquery, location) => {
  const [rows] = await bigquery.query({
    query: `SELECT
      (SELECT COUNT(*) FROM \`${projectId}.${datasetId}.income\`) AS income_count,
      (SELECT SUM(MONTANT_CHF) FROM \`${projectId}.${datasetId}.income\`) AS income_chf,
      (SELECT SUM(MONTANT_CFA) FROM \`${projectId}.${datasetId}.income\`) AS income_cfa,
      (SELECT COUNT(*) FROM \`${projectId}.${datasetId}.expenses\`) AS expense_count,
      (SELECT SUM(CHF) FROM \`${projectId}.${datasetId}.expenses\`) AS expense_chf,
      (SELECT SUM(CFA) FROM \`${projectId}.${datasetId}.expenses\`) AS expense_cfa,
      (SELECT COUNT(*) FROM \`${projectId}.${datasetId}.income\`
        WHERE UPPER(TRIM(NATURE_RECETTE)) IN ('AIDE SOCIALE MENAGE','AIDE SOCIALE MÉNAGE','AIDE SOCIALE')) AS social_count,
      (SELECT SUM(MONTANT_CHF) FROM \`${projectId}.${datasetId}.income\`
        WHERE UPPER(TRIM(NATURE_RECETTE)) IN ('AIDE SOCIALE MENAGE','AIDE SOCIALE MÉNAGE','AIDE SOCIALE')) AS social_chf,
      (SELECT SUM(MONTANT_CFA) FROM \`${projectId}.${datasetId}.income\`
        WHERE UPPER(TRIM(NATURE_RECETTE)) IN ('AIDE SOCIALE MENAGE','AIDE SOCIALE MÉNAGE','AIDE SOCIALE')) AS social_cfa`,
    location
  });
  return rows[0];
};

const summaryMatches = (summary, metadata) => (
  Number(summary.income_count) === metadata.income_count
  && Number(summary.expense_count) === metadata.expense_count
  && Number(summary.social_count) === metadata.social_count
  && closeEnough(summary.income_chf, metadata.income_total_chf)
  && closeEnough(summary.income_cfa, metadata.income_total_cfa)
  && closeEnough(summary.expense_chf, metadata.expense_total_chf)
  && closeEnough(summary.expense_cfa, metadata.expense_total_cfa)
  && closeEnough(summary.social_chf, metadata.social_total_chf)
  && closeEnough(summary.social_cfa, metadata.social_total_cfa)
);

const incomeMatches = (summary, metadata) => (
  Number(summary.income_count) === metadata.income_count
  && Number(summary.social_count) === metadata.social_count
  && closeEnough(summary.income_chf, metadata.income_total_chf)
  && closeEnough(summary.income_cfa, metadata.income_total_cfa)
  && closeEnough(summary.social_chf, metadata.social_total_chf)
  && closeEnough(summary.social_cfa, metadata.social_total_cfa)
);

const expensesMatch = (summary, metadata) => (
  Number(summary.expense_count) === metadata.expense_count
  && closeEnough(summary.expense_chf, metadata.expense_total_chf)
  && closeEnough(summary.expense_cfa, metadata.expense_total_cfa)
);

const main = async () => {
  const payload = await readStdin();
  verifyPayload(payload);
  const bigquery = new BigQuery({ projectId, ...(keyFilename ? { keyFilename } : {}) });
  const dataset = bigquery.dataset(datasetId);
  const [datasetMetadata] = await dataset.getMetadata();
  const location = datasetMetadata.location;
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', projectId, datasetId, location, metadata: payload.metadata }, null, 2));
  if (!apply) return;

  const incomeTable = dataset.table('income');
  const expenseTable = dataset.table('expenses');
  const [incomeExists] = await incomeTable.exists();
  const [expenseExists] = await expenseTable.exists();
  if (incomeExists && expenseExists) {
    const summary = await querySummary(bigquery, location);
    if (summaryMatches(summary, payload.metadata)) {
      console.log(JSON.stringify({ status: 'already-imported', summary }, null, 2));
      return;
    }
    const incomeHasRows = Number(summary.income_count) > 0;
    const expensesHaveRows = Number(summary.expense_count) > 0;
    if ((incomeHasRows && !incomeMatches(summary, payload.metadata))
      || (expensesHaveRows && !expensesMatch(summary, payload.metadata))) {
      throw new Error(`Finance tables already exist with different data: ${JSON.stringify(summary)}`);
    }
  }

  if (!incomeExists) {
    await dataset.createTable('income', { schema: incomeSchema, description: 'Recettes historiques gouvernées importées depuis RECETTES.xlsm.' });
  }
  if (!expenseExists) {
    await dataset.createTable('expenses', { schema: expenseSchema, description: 'Dépenses historiques gouvernées importées depuis BDD_DEPENSES.xlsx.' });
  }
  const current = await querySummary(bigquery, location);
  if (Number(current.income_count) === 0) {
    await incomeTable.insert(payload.income, { skipInvalidRows: false, ignoreUnknownValues: false });
  }
  if (Number(current.expense_count) === 0) {
    await expenseTable.insert(payload.expenses, { skipInvalidRows: false, ignoreUnknownValues: false });
  }

  const summary = await querySummary(bigquery, location);
  if (!summaryMatches(summary, payload.metadata)) throw new Error(`Post-import verification failed: ${JSON.stringify(summary)}`);
  console.log(JSON.stringify({ status: 'imported-and-verified', summary }, null, 2));
};

main().catch((error) => {
  console.error(error.stack || error.message);
  if (error.errors) console.error(JSON.stringify(error.errors.slice(0, 10), null, 2));
  process.exitCode = 1;
});

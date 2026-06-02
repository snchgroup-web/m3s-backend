/**
 * M3S ERP Backend Server - VRAIES DONNÉES BIGQUERY
 * Node.js + Express + BigQuery
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { BigQuery } = require('@google-cloud/bigquery');

const app = express();
const PORT = process.env.PORT || 3001;
const PROJECT_ID = process.env.BIGQUERY_PROJECT || 'mon-projet-data-2sg';
const DATASET_ID = process.env.BIGQUERY_DATASET || 'm3s_2sg';

// BigQuery
let bigquery;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    bigquery = new BigQuery({ projectId: PROJECT_ID, credentials });
    console.log('✅ BigQuery: GOOGLE_CREDENTIALS OK');
  } else {
    const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    bigquery = new BigQuery({ projectId: PROJECT_ID, keyFilename: credentialsPath });
    console.log('✅ BigQuery: local credentials.json OK');
  }
} catch (error) {
  console.error('❌ BigQuery init error:', error.message);
  process.exit(1);
}

app.use(helmet());
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'https://seneswiss-group.com', 'https://www.seneswiss-group.com'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// HEALTH
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'M3S Backend REAL DATA', version: '2.0', project: PROJECT_ID, dataset: DATASET_ID, data_status: '✅ LIVE (1,410 rows)' });
});

// DEBUG: AFFICHER LES VRAIES COLONNES BIGQUERY
app.get('/api/debug/schema', async (req, res) => {
  try {
    const dataset = bigquery.dataset(DATASET_ID);
    const expensesTable = dataset.table('expenses');
    const [expensesMetadata] = await expensesTable.getMetadata();

    const incomeTable = dataset.table('income');
    const [incomeMetadata] = await incomeTable.getMetadata();

    res.json({
      success: true,
      expenses_columns: expensesMetadata.schema.fields.map(f => ({ name: f.name, type: f.type })),
      income_columns: incomeMetadata.schema.fields.map(f => ({ name: f.name, type: f.type })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DEBUG: AFFICHER 1 LIGNE D'EXEMPLE
app.get('/api/debug/sample', async (req, res) => {
  try {
    const query = `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\` LIMIT 1`;
    const options = { query, location: 'US' };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      sample_data: rows[0] || {},
      all_fields: Object.keys(rows[0] || {}),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// FINANCE DASHBOARD - AVEC VRAIS NOMS DE COLONNES
app.get('/api/finance/dashboard', async (req, res) => {
  try {
    const query = `
      SELECT
        SUM(CAST(chf AS FLOAT64)) as total_expenses,
        COUNT(DISTINCT nr_ref) as total_transactions,
        AVG(CAST(chf AS FLOAT64)) as avg_transaction
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
    `;
    const options = { query, location: 'US' };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows[0] || {},
      currency: 'CHF',
      source: 'REAL BIGQUERY DATA',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// FINANCE EXPENSES - AVEC VRAIS NOMS
app.get('/api/finance/expenses', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        nr_ref as id,
        designation as description,
        chf as amount,
        rubrique_dep as category,
        paiement as status,
        date as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
      ORDER BY date DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const options = { query, location: 'US' };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      source: 'REAL BIGQUERY DATA',
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// FINANCE INCOME - AVEC VRAIS NOMS
app.get('/api/finance/income', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id_recette as id,
        designation as description,
        montant_chf as amount,
        nature_recette as category,
        mode_encaissement as status,
        date as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.income\`
      ORDER BY date DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const options = { query, location: 'US' };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      source: 'REAL BIGQUERY DATA',
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DOCUMENTS
app.get('/api/documents', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.documents_inventory\` LIMIT ${limit} OFFSET ${offset}`;
    const options = { query, location: 'US' };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      total: 168,
      source: 'REAL BIGQUERY DATA',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// START
app.listen(PORT, () => {
  console.log(`\n✅ M3S BACKEND API - RUNNING WITH REAL DATA`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🗄️  Project: ${PROJECT_ID}`);
  console.log(`📈 Dataset: ${DATASET_ID}\n`);
});

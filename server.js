/**
 * M3S ERP Backend Server - FIXED VERSION
 * Node.js + Express + BigQuery
 *
 * CORRECTION: Routes adaptées aux appels du frontend
 * Démarrage: npm start
 * Port: http://localhost:3001
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { BigQuery } = require('@google-cloud/bigquery');

// ============================================================================
// INITIALISATION
// ============================================================================

const app = express();
const PORT = process.env.PORT || 3001;
const PROJECT_ID = 'mon-projet-data-2sg';
const DATASET_ID = 'm3s_2sg';
const DATASET_LOCATION = 'US';

// BigQuery client
const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
const bigquery = new BigQuery({
  projectId: PROJECT_ID,
  keyFilename: credentialsPath
});

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) as count FROM \`${PROJECT_ID}.${DATASET_ID}.documents\` LIMIT 1`;
    await bigquery.query({ query, location: DATASET_LOCATION });

    res.json({
      status: 'ok',
      service: 'M3S Backend',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      bigquery: 'connected',
      project: PROJECT_ID,
      dataset: DATASET_ID
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - FINANCE (EXPENSES)
// ============================================================================

app.get('/api/finance/expenses', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        description,
        montant,
        type,
        statut,
        category,
        date_created,
        date_updated
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
      ORDER BY date_created DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    console.log(`✅ Expenses returned: ${rows.length} rows`);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Expenses Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - FINANCE (INCOME)
// ============================================================================

app.get('/api/finance/income', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        description,
        montant,
        type,
        statut,
        category,
        date_created,
        date_updated
      FROM \`${PROJECT_ID}.${DATASET_ID}.income\`
      ORDER BY date_created DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    console.log(`✅ Income returned: ${rows.length} rows`);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Income Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - FINANCE DASHBOARD
// ============================================================================

app.get('/api/finance/dashboard', async (req, res) => {
  try {
    const query = `
      SELECT
        (SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET_ID}.income\`) as total_income_count,
        (SELECT SUM(montant) FROM \`${PROJECT_ID}.${DATASET_ID}.income\`) as total_income,
        (SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`) as total_expense_count,
        (SELECT SUM(montant) FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`) as total_expenses
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows[0] || {},
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Dashboard Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - DOCUMENTS (GED)
// ============================================================================

app.get('/api/documents', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        nom as name,
        type,
        taille as size,
        dossier as folder,
        dateCreation as created_at,
        statut as status
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents\`
      ORDER BY dateCreation DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    console.log(`✅ Documents returned: ${rows.length} rows`);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Documents Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/documents/count', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) as total FROM \`${PROJECT_ID}.${DATASET_ID}.documents\``;
    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      total: rows[0]?.total || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - INVENTORY (PRODUCTION)
// ============================================================================

app.get('/api/inventory', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        nom as name,
        quantite as quantity,
        prix as price,
        statut as status
      FROM \`${PROJECT_ID}.${DATASET_ID}.inventory\`
      ORDER BY id
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/inventory/count', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) as total FROM \`${PROJECT_ID}.${DATASET_ID}.inventory\``;
    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      total: rows[0]?.total || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - TASKS (CRM)
// ============================================================================

app.get('/api/tasks', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        titre as title,
        description,
        statut as status,
        priorite as priority,
        date_creation as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.tasks\`
      ORDER BY date_creation DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/tasks/count', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) as total FROM \`${PROJECT_ID}.${DATASET_ID}.tasks\``;
    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      total: rows[0]?.total || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - USERS (RH)
// ============================================================================

app.get('/api/users', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        nom as name,
        email,
        poste as position,
        departement as department,
        statut as status
      FROM \`${PROJECT_ID}.${DATASET_ID}.users\`
      ORDER BY nom
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - FX RATES
// ============================================================================

app.get('/api/fx-rates', async (req, res) => {
  try {
    const query = `
      SELECT
        devise_source as source_currency,
        devise_cible as target_currency,
        taux as rate,
        date as date_updated
      FROM \`${PROJECT_ID}.${DATASET_ID}.fx_rates\`
      ORDER BY date DESC
      LIMIT 100
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// API ROUTES - INFO
// ============================================================================

app.get('/api/info', (req, res) => {
  res.json({
    service: 'M3S Backend API',
    version: '2.0',
    endpoints: {
      finance: [
        'GET /api/finance/expenses?limit=100&offset=0',
        'GET /api/finance/income?limit=100&offset=0',
        'GET /api/finance/dashboard'
      ],
      documents: [
        'GET /api/documents?limit=100&offset=0',
        'GET /api/documents/count'
      ],
      inventory: [
        'GET /api/inventory?limit=100&offset=0',
        'GET /api/inventory/count'
      ],
      tasks: [
        'GET /api/tasks?limit=100&offset=0',
        'GET /api/tasks/count'
      ],
      users: [
        'GET /api/users?limit=100&offset=0'
      ],
      fx_rates: [
        'GET /api/fx-rates'
      ],
      health: [
        'GET /api/health'
      ]
    },
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🚀 M3S BACKEND API - FIXED & RUNNING                         ║
║  URL: http://localhost:3001                                 ║
║  BigQuery: ${PROJECT_ID}.${DATASET_ID}                       ║
║  Environment: development                                   ║
╚════════════════════════════════════════════════════════════════╝

✅ API IS RUNNING!

📊 Ready Endpoints:
  ✓ GET /api/finance/expenses
  ✓ GET /api/finance/income
  ✓ GET /api/documents
  ✓ GET /api/inventory
  ✓ GET /api/tasks
  ✓ GET /api/users
  ✓ GET /api/fx-rates
  ✓ GET /api/health
  ✓ GET /api/info

🌐 Test: curl http://localhost:3001/api/health
  `);
});


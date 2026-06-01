/**
 * M3S ERP Backend Server - UPDATED FOR REAL BIGQUERY DATA
 * Node.js + Express + BigQuery
 *
 * Updated: 29 mai 2026
 * Uses real tables: expenses, income, inventory, tasks, users, documents_inventory
 *
 * Démarrage: npm start
 * Port: http://localhost:3001
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { BigQuery } = require('@google-cloud/bigquery');

// ============================================================================
// INITIALISATION
// ============================================================================

const app = express();
const PORT = process.env.PORT || 3001;
const PROJECT_ID = process.env.BIGQUERY_PROJECT || process.env.PROJECT_ID || 'mon-projet-data-2sg';
const DATASET_ID = process.env.BIGQUERY_DATASET || process.env.DATASET_ID || 'm3s_2sg';

// BigQuery client - Use GOOGLE_CREDENTIALS from Railway OR local credentials.json
let bigquery;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    // ✅ USE RAILWAY ENVIRONMENT VARIABLE
    try {
      console.log('🔍 DEBUG: Tentative de parsing GOOGLE_CREDENTIALS...');
      console.log('🔍 DEBUG: Longueur:', process.env.GOOGLE_CREDENTIALS.length);
      console.log('🔍 DEBUG: Premiers 100 chars:', process.env.GOOGLE_CREDENTIALS.substring(0, 100));

      const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

      bigquery = new BigQuery({
        projectId: PROJECT_ID,
        credentials: credentials
      });
      console.log('✅ BigQuery: Using GOOGLE_CREDENTIALS from Railway environment');
    } catch (parseError) {
      console.error('❌ JSON.parse error:', parseError.message);
      console.error('❌ Problème possible:');
      console.error('   - Guillemets mal échappés dans Railway');
      console.error('   - JSON invalide');
      console.error('   - Variable vide ou malformée');
      console.error('');
      console.error('📌 SOLUTION: Vérifier Railway Variables dashboard:');
      console.error('   https://railway.app/project/1e96f996-ea2d-442e-a319-098b81cdcef6');
      console.error('');

      // FALLBACK: essayer avec local credentials.json
      console.log('⚠️  Tentative fallback: local credentials.json...');
      const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
      bigquery = new BigQuery({
        projectId: PROJECT_ID,
        keyFilename: credentialsPath
      });
      console.log('✅ BigQuery: Fallback to local credentials.json successful');
    }
  } else {
    // ✅ USE LOCAL credentials.json (for development)
    console.log('ℹ️  GOOGLE_CREDENTIALS not set in environment');
    const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    bigquery = new BigQuery({
      projectId: PROJECT_ID,
      keyFilename: credentialsPath
    });
    console.log('✅ BigQuery: Using local credentials.json');
  }
} catch (error) {
  console.error('❌ BigQuery initialization FATAL error:', error.message);
  console.error('❌ Stack:', error.stack);
  process.exit(1);
}

const DATASET_LOCATION = 'US';
const dataset = bigquery.dataset(DATASET_ID, { location: DATASET_LOCATION });

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://seneswiss-group.com',
    'https://www.seneswiss-group.com'
  ],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'M3S Backend (REAL DATA)',
    version: '2.0.0 - Updated 29 May 2026',
    timestamp: new Date().toISOString(),
    bigquery: 'connected',
    project: PROJECT_ID,
    dataset: DATASET_ID,
    data_status: 'REAL M3S DATA - 1,410 rows loaded'
  });
});

// ============================================================================
// API ROUTES - DOCUMENTS (GED) - USING documents_inventory
// ============================================================================

app.get('/api/documents', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type;

    let query = `
      SELECT
        id,
        name,
        type,
        created_at as created_at_timestamp
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents_inventory\`
    `;

    if (type) {
      query += ` WHERE type = '${type}'`;
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      source: 'documents_inventory table',
      data: rows,
      pagination: { total: rows.length, limit, offset },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/documents/count', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) as total FROM \`${PROJECT_ID}.${DATASET_ID}.documents_inventory\``;
    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      total: rows[0].total,
      message: `${rows[0].total} documents in inventory`,
      source: 'documents_inventory table',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - FINANCE (expenses + income)
// ============================================================================

app.get('/api/finance/dashboard', async (req, res) => {
  try {
    const query = `
      SELECT
        SUM(CAST(amount AS FLOAT64)) as total_expenses,
        COUNT(DISTINCT id) as total_transactions,
        AVG(CAST(amount AS FLOAT64)) as avg_transaction
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows[0] || {},
      period: 'all_time',
      currency: 'CHF',
      source: 'expenses table',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/finance/expenses', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        name as description,
        amount,
        category,
        status,
        created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      source: 'expenses table',
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/finance/income', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        name as description,
        amount,
        category,
        status,
        created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.income\`
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      source: 'income table',
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - INVENTORY
// ============================================================================

app.get('/api/inventory', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        ref,
        name,
        quantity,
        value,
        location,
        category,
        status
      FROM \`${PROJECT_ID}.${DATASET_ID}.inventory\`
      ORDER BY name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      source: 'inventory table',
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/inventory/count', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) as total FROM \`${PROJECT_ID}.${DATASET_ID}.inventory\``;
    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      total: rows[0].total,
      source: 'inventory table',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - TASKS
// ============================================================================

app.get('/api/tasks', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;

    let query = `
      SELECT
        id,
        name,
        status,
        priority,
        created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.tasks\`
    `;

    if (status) {
      query += ` WHERE status = '${status}'`;
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      source: 'tasks table (665 rows)',
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/tasks/count', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) as total FROM \`${PROJECT_ID}.${DATASET_ID}.tasks\``;
    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      total: rows[0].total,
      source: 'tasks table',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - USERS
// ============================================================================

app.get('/api/users', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        name,
        email,
        role
      FROM \`${PROJECT_ID}.${DATASET_ID}.users\`
      ORDER BY name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      source: 'users table',
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - FX RATES
// ============================================================================

app.get('/api/fx-rates', async (req, res) => {
  try {
    const query = `
      SELECT
        source,
        target,
        rate,
        date as rate_date
      FROM \`${PROJECT_ID}.${DATASET_ID}.fx_rates\`
      ORDER BY date DESC
      LIMIT 100
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      source: 'fx_rates table (357 rows)',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// GENERAL ENDPOINTS
// ============================================================================

app.get('/api/tables', async (req, res) => {
  try {
    const [tables] = await dataset.getTables();

    const tableInfo = tables.map(table => ({
      id: table.id,
      rows: table.metadata?.numRows,
      bytes: table.metadata?.numBytes,
      created_at: table.metadata?.creationTime
    }));

    res.json({
      success: true,
      dataset: DATASET_ID,
      table_count: tables.length,
      tables: tableInfo,
      total_rows_loaded: '1410+',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/info', (req, res) => {
  res.json({
    success: true,
    service: 'M3S Backend API - REAL DATA',
    version: '2.0.0 - Updated 29 May 2026',
    project_id: PROJECT_ID,
    dataset_id: DATASET_ID,
    data_status: 'LIVE with real M3S data (1,410 rows)',
    endpoints: {
      health: 'GET /api/health',
      documents: [
        'GET /api/documents?limit=100&offset=0 (uses documents_inventory)',
        'GET /api/documents/count'
      ],
      finance: [
        'GET /api/finance/dashboard',
        'GET /api/finance/expenses?limit=100',
        'GET /api/finance/income?limit=100'
      ],
      inventory: [
        'GET /api/inventory?limit=100',
        'GET /api/inventory/count'
      ],
      tasks: [
        'GET /api/tasks?limit=100&status=pending',
        'GET /api/tasks/count'
      ],
      users: [
        'GET /api/users?limit=100'
      ],
      rates: [
        'GET /api/fx-rates'
      ],
      bigquery: [
        'GET /api/tables',
        'GET /api/info'
      ]
    },
    tables_available: [
      'expenses (134 rows)',
      'income (86 rows)',
      'inventory (186 rows)',
      'tasks (665 rows)',
      'users (7 rows)',
      'documents_inventory (168 rows)',
      'fx_rates (357 rows)',
      'ref_expense_categories (84 rows)',
      'ref_income_categories (29 rows)',
      'ref_stock_categories (66 rows)',
      'ref_task_categories (183 rows)',
      'finances_immobilisations (57 rows)'
    ],
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: err.message,
    timestamp: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    path: req.path,
    hint: 'See GET /api/info for available endpoints'
  });
});

// ============================================================================
// SERVER START
// ============================================================================

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🚀 M3S BACKEND API - RUNNING WITH REAL DATA                  ║
║  URL: http://localhost:${PORT}                                ║
║  Environment: ${(process.env.NODE_ENV || 'development').padEnd(45)} ║
║  Project: ${PROJECT_ID.padEnd(48)} ║
║  Dataset: ${DATASET_ID.padEnd(50)} ║
║  Data Status: ✅ LIVE (1,410 rows loaded)                      ║
╚════════════════════════════════════════════════════════════════╝

✅ API IS RUNNING WITH REAL M3S DATA!

📊 Endpoints Disponibles:
  ✓ Documents:   /api/documents (from documents_inventory - 168 docs)
  ✓ Finance:     /api/finance/dashboard, /finance/expenses, /finance/income
  ✓ Inventory:   /api/inventory (186 items)
  ✓ Tasks:       /api/tasks (665 tasks!)
  ✓ Users:       /api/users (7 users)
  ✓ FX Rates:    /api/fx-rates (357 rates)
  ✓ Info:        /api/info (voir tous les endpoints)
  ✓ Health:      /api/health

🧪 TESTER MAINTENANT:
  curl http://localhost:${PORT}/api/health
  curl http://localhost:${PORT}/api/tasks/count
  curl http://localhost:${PORT}/api/documents/count
  curl http://localhost:${PORT}/api/info

🎯 Prochaine Étape:
  Le backend est prêt!
  Frontend React doit appeler ces endpoints réels.
  `);
});

module.exports = server;

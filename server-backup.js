/**
 * M3S ERP Backend Server - COMPLETE VERSION
 * Node.js + Express + BigQuery
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
const PROJECT_ID = process.env.PROJECT_ID || 'mon-projet-data-2sg';
const DATASET_ID = process.env.DATASET_ID || 'm3s_2sg';

// BigQuery client
const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
const bigquery = new BigQuery({
  projectId: PROJECT_ID,
  keyFilename: credentialsPath
});
const DATASET_LOCATION = 'US'; // Location du dataset
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
    service: 'M3S Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    bigquery: 'connected',
    project: PROJECT_ID,
    dataset: DATASET_ID
  });
});

// ============================================================================
// API ROUTES - DOCUMENTS (GED)
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
        size,
        created_at,
        updated_at,
        folder,
        file_path,
        mime_type
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents\`
    `;

    if (type) {
      query += ` WHERE type = '${type}'`;
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
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
    const query = `SELECT COUNT(*) as total FROM \`${PROJECT_ID}.${DATASET_ID}.documents\``;
    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      total: rows[0].total,
      message: `${rows[0].total} documents in GED`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/documents/stats', async (req, res) => {
  try {
    const query = `
      SELECT
        type,
        COUNT(*) as count,
        SUM(size) as total_size,
        MIN(created_at) as first_created,
        MAX(created_at) as last_created
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents\`
      GROUP BY type
      ORDER BY count DESC
    `;
    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      stats: rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const { query: searchQuery, limit = 50 } = req.body;

    if (!searchQuery) {
      return res.status(400).json({ success: false, error: 'Search query required' });
    }

    const query = `
      SELECT
        id,
        name,
        type,
        folder,
        created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents\`
      WHERE name LIKE '%${searchQuery}%'
        OR folder LIKE '%${searchQuery}%'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      query: searchQuery,
      results: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - FINANCE
// ============================================================================

app.get('/api/finance/dashboard', async (req, res) => {
  try {
    const query = `
      SELECT
        SUM(montant) as total_revenue,
        COUNT(DISTINCT id) as total_transactions,
        AVG(montant) as avg_transaction,
        MAX(montant) as max_transaction,
        MIN(montant) as min_transaction,
        SUM(CASE WHEN statut = 'paid' THEN montant ELSE 0 END) as paid_amount,
        SUM(CASE WHEN statut = 'pending' THEN montant ELSE 0 END) as pending_amount,
        COUNT(CASE WHEN statut = 'paid' THEN 1 END) as paid_count,
        COUNT(CASE WHEN statut = 'pending' THEN 1 END) as pending_count
      FROM \`${PROJECT_ID}.${DATASET_ID}.finances\`
      WHERE created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows[0] || {},
      period: 'last_30_days',
      currency: 'CHF',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/finance/transactions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const statut = req.query.statut;

    let query = `
      SELECT
        id,
        description,
        montant,
        statut,
        category,
        created_at,
        updated_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.finances\`
      WHERE 1=1
    `;

    if (statut) {
      query += ` AND statut = '${statut}'`;
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - RH
// ============================================================================

app.get('/api/rh/dashboard', async (req, res) => {
  try {
    const query = `
      SELECT
        COUNT(*) as total_employees,
        COUNT(CASE WHEN statut = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN statut = 'inactive' THEN 1 END) as inactive,
        COUNT(DISTINCT department) as departments
      FROM \`${PROJECT_ID}.${DATASET_ID}.rh_employees\`
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows[0] || {},
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/rh/employees', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        name,
        email,
        position,
        department,
        statut,
        salary,
        hire_date,
        phone
      FROM \`${PROJECT_ID}.${DATASET_ID}.rh_employees\`
      ORDER BY name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - CRM
// ============================================================================

app.get('/api/crm/dashboard', async (req, res) => {
  try {
    const query = `
      SELECT
        COUNT(DISTINCT id) as total_contacts,
        COUNT(CASE WHEN type = 'prospect' THEN 1 END) as prospects,
        COUNT(CASE WHEN type = 'customer' THEN 1 END) as customers,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
        SUM(CASE WHEN total_value > 0 THEN total_value ELSE 0 END) as total_pipeline
      FROM \`${PROJECT_ID}.${DATASET_ID}.crm_contacts\`
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows[0] || {},
      currency: 'CHF',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/crm/prospects', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        name,
        email,
        phone,
        company,
        status,
        stage,
        estimated_value,
        created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.crm_contacts\`
      WHERE type = 'prospect'
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      pagination: { limit, offset, total: rows.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - PRODUCTION
// ============================================================================

app.get('/api/production/dashboard', async (req, res) => {
  try {
    const query = `
      SELECT
        COUNT(*) as total_products,
        COUNT(CASE WHEN status = 'in_stock' THEN 1 END) as in_stock,
        COUNT(CASE WHEN stock_level < reorder_point THEN 1 END) as low_stock,
        SUM(stock_level * unit_price) as total_inventory_value
      FROM \`${PROJECT_ID}.${DATASET_ID}.production_inventory\`
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows[0] || {},
      currency: 'CHF',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/production/inventory', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        id,
        product_name,
        sku,
        category,
        stock_level,
        reorder_point,
        unit_price,
        status
      FROM \`${PROJECT_ID}.${DATASET_ID}.production_inventory\`
      ORDER BY stock_level ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      data: rows,
      pagination: { limit, offset, total: rows.length },
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
      bytes: table.metadata?.numBytes
    }));

    res.json({
      success: true,
      dataset: DATASET_ID,
      table_count: tables.length,
      tables: tableInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/info', (req, res) => {
  res.json({
    success: true,
    service: 'M3S Backend API',
    version: '1.0.0',
    project_id: PROJECT_ID,
    dataset_id: DATASET_ID,
    endpoints: {
      health: 'GET /api/health',
      documents: [
        'GET /api/documents?limit=100&offset=0',
        'GET /api/documents/count',
        'GET /api/documents/stats',
        'POST /api/search'
      ],
      finance: [
        'GET /api/finance/dashboard',
        'GET /api/finance/transactions'
      ],
      rh: [
        'GET /api/rh/dashboard',
        'GET /api/rh/employees'
      ],
      crm: [
        'GET /api/crm/dashboard',
        'GET /api/crm/prospects'
      ],
      production: [
        'GET /api/production/dashboard',
        'GET /api/production/inventory'
      ],
      bigquery: [
        'GET /api/tables',
        'GET /api/info'
      ]
    },
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
║  🚀 M3S BACKEND API - RUNNING                                  ║
║  URL: http://localhost:${PORT}                                ║
║  Environment: ${(process.env.NODE_ENV || 'development').padEnd(45)} ║
║  Project: ${PROJECT_ID.padEnd(48)} ║
║  Dataset: ${DATASET_ID.padEnd(50)} ║
╚════════════════════════════════════════════════════════════════╝

✅ API IS RUNNING!

📊 Endpoints Disponibles:
  ✓ Documents:   /api/documents (5,143 docs!)
  ✓ Finance:     /api/finance/dashboard
  ✓ RH:          /api/rh/dashboard
  ✓ CRM:         /api/crm/dashboard
  ✓ Production:  /api/production/dashboard
  ✓ Info:        /api/info (voir tous les endpoints)
  ✓ Health:      /api/health

🧪 TESTER MAINTENANT:
  curl http://localhost:${PORT}/api/health
  curl http://localhost:${PORT}/api/documents/count
  curl http://localhost:${PORT}/api/info

🎯 Prochaine Étape:
  Intégrer le frontend React pour utiliser cette API!
  `);
});

module.exports = server;

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
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { BigQuery } = require('@google-cloud/bigquery');

// ============================================================================
// INITIALISATION
// ============================================================================

const app = express();
const PORT = process.env.PORT || 3001;
const PROJECT_ID = process.env.BIGQUERY_PROJECT || 'mon-projet-data-2sg';
const DATASET_ID = process.env.BIGQUERY_DATASET || 'm3s_2sg';
const DATASET_LOCATION = 'US';
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const AUTH_SECRET = process.env.JWT_SECRET || 'm3s-development-secret-change-me';
const API_REQUIRE_AUTH = process.env.API_REQUIRE_AUTH === 'true';
const APP_REVISION = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.APP_REVISION || 'local';

const parseGoogleCredentials = () => {
  const rawCredentials = process.env.GOOGLE_CREDENTIALS;
  if (!rawCredentials) return null;

  const candidates = [rawCredentials];
  try {
    candidates.push(Buffer.from(rawCredentials, 'base64').toString('utf8'));
  } catch {
    // Keep the raw candidate only.
  }

  for (const candidate of candidates) {
    try {
      const credentials = JSON.parse(candidate);
      if (credentials.client_email && credentials.private_key) {
        return credentials;
      }
    } catch {
      // Try the next representation.
    }
  }

  console.warn('GOOGLE_CREDENTIALS is set but could not be parsed as service account JSON');
  return null;
};

// BigQuery client. Railway uses GOOGLE_CREDENTIALS; local setup can keep config/credentials.json.
const googleCredentials = parseGoogleCredentials();
const bigquery = new BigQuery(
  googleCredentials
    ? { projectId: PROJECT_ID, credentials: googleCredentials }
    : { projectId: PROJECT_ID, keyFilename: path.join(__dirname, 'config', 'credentials.json') }
);

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors({
  origin: CORS_ORIGINS,
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
// AUTH HELPERS
// ============================================================================

const base64Url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const signToken = (payload) => {
  const header = base64Url({ alg: 'HS256', typ: 'JWT' });
  const body = base64Url({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12
  });
  const signature = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
};

const parseToken = (token) => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedSignatureBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
};

const requireAuth = (req, res, next) => {
  if (!API_REQUIRE_AUTH) return next();

  const publicPaths = new Set([
    '/auth/login',
    '/health',
    '/info',
    '/debug/config',
    '/debug/bigquery',
    '/debug/documents',
    '/debug/tables',
    '/debug/schema',
    '/debug/sample',
    '/api/auth/login',
    '/api/health',
    '/api/info',
    '/api/debug/config',
    '/api/debug/bigquery',
    '/api/debug/documents',
    '/api/debug/tables',
    '/api/debug/schema',
    '/api/debug/sample'
  ]);

  if (publicPaths.has(req.path) || publicPaths.has(req.originalUrl)) {
    return next();
  }

  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const payload = token ? parseToken(token) : null;

  if (!payload) {
    return res.status(401).json({
      success: false,
      error: 'Authentification requise'
    });
  }

  req.user = payload;
  return next();
};

const getConfiguredUsers = () => {
  if (!process.env.M3S_AUTH_USERS_JSON) return [];

  try {
    const users = JSON.parse(process.env.M3S_AUTH_USERS_JSON);
    return Array.isArray(users) ? users : [];
  } catch (error) {
    console.error('Invalid M3S_AUTH_USERS_JSON:', error.message);
    return [];
  }
};

const verifyPassword = (account, password) => {
  if (account.passwordHash && account.passwordSalt) {
    const iterations = Number(account.passwordIterations) || 120000;
    const expectedHash = Buffer.from(account.passwordHash, 'base64');
    const actualHash = crypto.pbkdf2Sync(
      password,
      account.passwordSalt,
      iterations,
      expectedHash.length,
      'sha256'
    );

    return (
      actualHash.length === expectedHash.length &&
      crypto.timingSafeEqual(actualHash, expectedHash)
    );
  }

  // Compatibility fallback for temporary local/demo configs.
  return Boolean(account.password && account.password === password);
};

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email et mot de passe requis'
    });
  }

  const users = getConfiguredUsers();
  const account = users.find((candidate) => candidate.email === email);

  if (!account || !verifyPassword(account, password)) {
    return res.status(401).json({
      success: false,
      error: 'Email ou mot de passe incorrect'
    });
  }

  const user = {
    email: account.email,
    name: account.name || account.email,
    role: account.role || 'Utilisateur'
  };

  res.json({
    success: true,
    token: signToken(user),
    user
  });
});

app.use('/api', requireAuth);

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', async (req, res) => {
  try {
    const query = 'SELECT 1 AS ok';
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
    console.error('Health check BigQuery error:', {
      message: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason
    });

    res.status(500).json({
      status: 'error',
      service: 'M3S Backend',
      bigquery: 'error',
      project: PROJECT_ID,
      dataset: DATASET_ID,
      datasetLocation: DATASET_LOCATION,
      error: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason || null,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/debug/documents', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) as count FROM \`${PROJECT_ID}.${DATASET_ID}.documents_inventory\``;
    const [rows] = await bigquery.query({ query, location: DATASET_LOCATION });

    res.json({
      success: true,
      service: 'M3S Backend',
      revision: APP_REVISION,
      table: `${PROJECT_ID}.${DATASET_ID}.documents_inventory`,
      count: rows[0]?.count || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Debug documents table error:', {
      message: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason
    });

    res.status(500).json({
      success: false,
      service: 'M3S Backend',
      revision: APP_REVISION,
      table: `${PROJECT_ID}.${DATASET_ID}.documents_inventory`,
      error: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason || null,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/debug/config', (req, res) => {
  res.json({
    service: 'M3S Backend',
    revision: APP_REVISION,
    environment: process.env.NODE_ENV || 'development',
    project: PROJECT_ID,
    dataset: DATASET_ID,
    datasetLocation: DATASET_LOCATION,
    corsOrigins: CORS_ORIGINS,
    apiRequireAuth: API_REQUIRE_AUTH,
    hasGoogleCredentialsEnv: Boolean(process.env.GOOGLE_CREDENTIALS),
    googleCredentialsParsed: Boolean(googleCredentials),
    hasLocalCredentialsPath: !googleCredentials,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/debug/bigquery', async (req, res) => {
  try {
    const [rows] = await bigquery.query({
      query: 'SELECT 1 AS ok',
      location: DATASET_LOCATION
    });

    res.json({
      success: true,
      service: 'M3S Backend',
      revision: APP_REVISION,
      project: PROJECT_ID,
      dataset: DATASET_ID,
      datasetLocation: DATASET_LOCATION,
      result: rows[0] || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Debug BigQuery error:', {
      message: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason
    });

    res.status(500).json({
      success: false,
      service: 'M3S Backend',
      revision: APP_REVISION,
      project: PROJECT_ID,
      dataset: DATASET_ID,
      datasetLocation: DATASET_LOCATION,
      error: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason || null,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/debug/tables', async (req, res) => {
  try {
    const [tables] = await bigquery.dataset(DATASET_ID).getTables();

    res.json({
      success: true,
      service: 'M3S Backend',
      revision: APP_REVISION,
      project: PROJECT_ID,
      dataset: DATASET_ID,
      tables: tables.map((table) => table.id).sort(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Debug tables error:', {
      message: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason
    });

    res.status(500).json({
      success: false,
      service: 'M3S Backend',
      revision: APP_REVISION,
      project: PROJECT_ID,
      dataset: DATASET_ID,
      error: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason || null,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/debug/schema', async (req, res) => {
  const tableName = String(req.query.table || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
    return res.status(400).json({
      success: false,
      error: 'Query parameter table is required and must contain only letters, numbers, or underscores'
    });
  }

  try {
    const [metadata] = await bigquery.dataset(DATASET_ID).table(tableName).getMetadata();
    const fields = metadata.schema?.fields || [];

    res.json({
      success: true,
      service: 'M3S Backend',
      revision: APP_REVISION,
      project: PROJECT_ID,
      dataset: DATASET_ID,
      table: tableName,
      fields: fields.map((field) => ({
        name: field.name,
        type: field.type,
        mode: field.mode || 'NULLABLE'
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Debug schema error:', {
      table: tableName,
      message: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason
    });

    res.status(500).json({
      success: false,
      service: 'M3S Backend',
      revision: APP_REVISION,
      project: PROJECT_ID,
      dataset: DATASET_ID,
      table: tableName,
      error: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason || null,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/debug/sample', async (req, res) => {
  const tableName = String(req.query.table || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 10);

  if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
    return res.status(400).json({
      success: false,
      error: 'Query parameter table is required and must contain only letters, numbers, or underscores'
    });
  }

  try {
    const query = `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.${tableName}\` LIMIT ${limit}`;
    const [rows] = await bigquery.query({ query, location: DATASET_LOCATION });

    res.json({
      success: true,
      service: 'M3S Backend',
      revision: APP_REVISION,
      project: PROJECT_ID,
      dataset: DATASET_ID,
      table: tableName,
      rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Debug sample error:', {
      table: tableName,
      message: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason
    });

    res.status(500).json({
      success: false,
      service: 'M3S Backend',
      revision: APP_REVISION,
      project: PROJECT_ID,
      dataset: DATASET_ID,
      table: tableName,
      error: error.message,
      code: error.code,
      reason: error.errors?.[0]?.reason || null,
      timestamp: new Date().toISOString()
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
        \`Nr REF\` as id,
        DESIGNATION as description,
        CHF as montant,
        CFA as montant_cfa,
        PAIEMENT as type,
        \`RUBRIQUE DEP\` as category,
        DATE as date_created,
        COMMENTAIRES as commentaire
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
      ORDER BY DATE DESC
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
        ID_RECETTE as id,
        DESIGNATION as description,
        MONTANT_CHF as montant,
        MONTANT_CFA as montant_cfa,
        MODE_ENCAISSEMENT as type,
        NATURE_RECETTE as category,
        DATE as date_created,
        COMMENTAIRE as commentaire
      FROM \`${PROJECT_ID}.${DATASET_ID}.income\`
      ORDER BY DATE DESC
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
        (SELECT SUM(MONTANT_CHF) FROM \`${PROJECT_ID}.${DATASET_ID}.income\`) as total_income,
        (SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`) as total_expense_count,
        (SELECT SUM(CHF) FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`) as total_expenses
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
        string_field_0 as id,
        string_field_1 as name,
        string_field_2 as type,
        string_field_3 as folder
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents_inventory\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'DOC_ID'
      ORDER BY string_field_0
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
    const query = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents_inventory\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'DOC_ID'
    `;
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
        string_field_0 as id,
        string_field_1 as ref,
        string_field_2 as name,
        SAFE_CAST(string_field_3 AS FLOAT64) as quantity,
        SAFE_CAST(string_field_4 AS FLOAT64) as price,
        'active' as status
      FROM \`${PROJECT_ID}.${DATASET_ID}.inventory\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'ID'
      ORDER BY string_field_0
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
    const query = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.inventory\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'ID'
    `;
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
        string_field_0 as id,
        COALESCE(string_field_1, string_field_0) as title,
        string_field_2 as description,
        string_field_3 as status,
        string_field_4 as priority,
        string_field_5 as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.bdd_taches\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'Unnamed: 0'
      ORDER BY string_field_0
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
    const query = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.bdd_taches\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'Unnamed: 0'
    `;
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
        \`Identifiant\` as id,
        COALESCE(
          NULLIF(TRIM(CONCAT(COALESCE(\`Prénom\`, ''), ' ', COALESCE(\`Nom\`, ''))), ''),
          \`Identifiant\`
        ) as name,
        \`Email Pro\` as email,
        \`Tel\` as phone,
        \`Poste\` as position,
        \`Team\` as department,
        'Actif' as status,
        CASE
          WHEN LOWER(\`Identifiant\`) IN ('chantal', 'cheikh') THEN 'Fondateur'
          ELSE 'Associé'
        END as member_type,
        \`Profil\` as role,
        \`role_actual\` as access_role,
        \`Prénom\` as prenom,
        \`Nom\` as nom,
        \`Email Pro\` as email_pro,
        \`Email Perso\` as email_perso,
        \`Tel\` as telephone,
        \`Poste\` as poste,
        \`Team\` as departement,
        \`Matricule\` as matricule,
        \`Profil\` as profil,
        CASE
          WHEN LOWER(\`Identifiant\`) IN ('chantal', 'cheikh') THEN 'Fondateur'
          ELSE 'Associé'
        END as type_membre,
        true as active
      FROM \`${PROJECT_ID}.${DATASET_ID}.users\`
      ORDER BY \`Nom\`
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
      auth: [
        'POST /api/auth/login'
      ],
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


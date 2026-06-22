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

const isMissingBigQueryTable = (error) => {
  const message = String(error?.message || '');
  return message.includes('Not found: Table') || message.includes('Not found: Dataset');
};

const runQueryWithFallback = async ({ preferredQuery, fallbackQuery, label }) => {
  try {
    return await bigquery.query({ query: preferredQuery, location: DATASET_LOCATION });
  } catch (error) {
    if (!fallbackQuery || !isMissingBigQueryTable(error)) {
      throw error;
    }
    console.warn(`${label}: table propre indisponible, fallback table historique`);
    return bigquery.query({ query: fallbackQuery, location: DATASET_LOCATION });
  }
};

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
        \`Nr REF\` as ref,
        DESIGNATION as description,
        CHF as montant,
        CHF as montant_chf,
        CFA as montant_cfa,
        SAFE_DIVIDE(CFA, NULLIF(CHF, 0)) as taux_fx,
        'CHF' as devise_origine,
        PAIEMENT as type,
        \`RUBRIQUE DEP\` as category,
        DATE as date_created,
        COALESCE(NULLIF(DEPARTEMENT, ''),
          CASE UPPER(REPLACE(BU, '_', ''))
            WHEN 'ADMINORG' THEN 'Administration'
            WHEN 'IMMO' THEN 'Finances'
            WHEN 'SOCIAL' THEN 'Finances'
            WHEN 'IMPORTEXPORT' THEN 'Commercial & CRM'
            ELSE BU END) as departement,
        COALESCE(NULLIF(TEAM, ''),
          CASE WHEN UPPER(PAYS) = 'CH' THEN 'Team_ZH'
               WHEN UPPER(PAYS) = 'SN' THEN 'Team_SN'
               ELSE NULL END) as team,
        PHASE as phase_projet,
        \` AGENT\` as agent,
        FOURNISSEUR as fournisseur,
        PAYS as pays,
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
        ID_RECETTE as ref,
        DESIGNATION as description,
        MONTANT_SAISI as montant_origine,
        DEVISE_SAISIE as devise_origine,
        MONTANT_CHF as montant,
        MONTANT_CHF as montant_chf,
        MONTANT_CFA as montant_cfa,
        TAUX_FX_APPLIQUE as taux_fx,
        MODE_ENCAISSEMENT as type,
        NATURE_RECETTE as category,
        DATE as date_created,
        COALESCE(NULLIF(DEPARTEMENT, ''),
          CASE UPPER(REPLACE(BU, '_', ''))
            WHEN 'ADMINORG' THEN 'Administration'
            WHEN 'IMMO' THEN 'Finances'
            WHEN 'SOCIAL' THEN 'Finances'
            WHEN 'IMPORTEXPORT' THEN 'Commercial & CRM'
            ELSE BU END) as departement,
        TEAM as team,
        PHASE as phase_projet,
        AGENT as agent,
        PAYS as pays,
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
// API ROUTES - FINANCE (FLUX SOCIAUX RECLASSES)
// ============================================================================

app.get('/api/finance/social', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const query = `
      SELECT
        ID_RECETTE as id,
        ID_RECETTE as ref,
        DATE as date_created,
        DESIGNATION as description,
        NATURE_RECETTE as category,
        MONTANT_CHF as montant_chf,
        MONTANT_CFA as montant_cfa,
        TAUX_FX_APPLIQUE as taux_fx,
        'Aide sociale' as nature_sociale,
        CASE
          WHEN REGEXP_CONTAINS(UPPER(DESIGNATION), r'FAMILLE|MENAGE') THEN 'Famille SN'
          ELSE NULL
        END as beneficiaire,
        AGENT as agent,
        TEAM as team,
        COALESCE(NULLIF(DEPARTEMENT, ''), 'Finances') as departement,
        PHASE as phase_projet,
        PAYS as pays,
        COMMENTAIRE as commentaire
      FROM \`${PROJECT_ID}.${DATASET_ID}.income\`
      WHERE UPPER(TRIM(NATURE_RECETTE)) IN ('AIDE SOCIALE MENAGE', 'AIDE SOCIALE MÉNAGE', 'AIDE SOCIALE')
      ORDER BY DATE DESC, ID_RECETTE DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await bigquery.query({ query, location: DATASET_LOCATION });
    const totalChf = rows.reduce((sum, row) => sum + numberOrZero(row.montant_chf), 0);
    const totalCfaHistorique = rows.reduce((sum, row) => sum + numberOrZero(row.montant_cfa), 0);
    const years = rows
      .map((row) => String(row.date_created?.value || row.date_created || '').slice(0, 4))
      .filter((year) => /^\d{4}$/.test(year));

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      summary: {
        total_chf: Number(totalChf.toFixed(2)),
        total_cfa_historique: Math.round(totalCfaHistorique),
        premiere_annee: years.length ? Math.min(...years.map(Number)) : null,
        derniere_annee: years.length ? Math.max(...years.map(Number)) : null
      },
      classification: {
        source_table: 'income',
        rule: 'NATURE_RECETTE = Aide Sociale Menage',
        accounting_scope: 'hors recettes exploitation'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Social Finance Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const numberOrZero = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeFinanceTransaction = (body, id, kind) => {
  const date = String(body.date || body.date_created || '').slice(0, 10);
  const description = String(body.description || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description) {
    throw new Error('La date et la designation sont obligatoires.');
  }
  const deviseOrigine = String(body.devise_origine || body.devise || 'CHF').toUpperCase();
  if (!['CHF', 'CFA'].includes(deviseOrigine)) throw new Error('La devise doit etre CHF ou CFA.');

  const montantOrigine = numberOrZero(body.montant_origine ?? body.montant);
  const montantChf = numberOrZero(body.montant_chf);
  const montantCfa = numberOrZero(body.montant_cfa);
  const tauxFx = numberOrZero(body.taux_fx);
  if (montantOrigine <= 0 || montantChf <= 0 || montantCfa <= 0 || tauxFx <= 0) {
    throw new Error('Les montants CHF/CFA et le taux historique exact sont obligatoires.');
  }
  return {
    id, date, description, montant_origine: montantOrigine, devise_origine: deviseOrigine,
    montant_chf: montantChf, montant_cfa: montantCfa, taux_fx: tauxFx,
    categorie: String(body.categorie || (kind === 'income' ? 'Recettes' : 'Depenses')),
    type: String(body.type || (kind === 'income' ? 'Virement' : 'Paiement')),
    departement: String(body.departement || ''), team: String(body.team || ''),
    phase_projet: String(body.phase_projet || ''), agent: String(body.agent || ''),
    pays: String(body.pays || ''), commentaire: String(body.commentaire || ''),
    fournisseur: String(body.fournisseur || ''), annee: Number(date.slice(0, 4))
  };
};

app.post('/api/finance/expenses', async (req, res) => {
  try {
    const row = normalizeFinanceTransaction(req.body, `DEP-APP-${Date.now()}`, 'expense');
    await bigquery.query({
      query: `INSERT INTO \`${PROJECT_ID}.${DATASET_ID}.expenses\`
        (\`Nr REF\`, DATE, DESIGNATION, CHF, CFA, PAIEMENT, \`POSTE  \`, \`OPERATION \`,
         \`RUBRIQUE DEP\`, BU, DEPARTEMENT, TEAM, PHASE, \` AGENT\`, FOURNISSEUR, PAYS, COMMENTAIRES)
        VALUES (@id,@date,@description,@montant_chf,@montant_cfa,@type,'','',@categorie,
                '',@departement,@team,@phase_projet,@agent,@fournisseur,@pays,@commentaire)`,
      params: row, location: DATASET_LOCATION
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    console.error('Create Expense Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/finance/expenses/:id', async (req, res) => {
  try {
    const row = normalizeFinanceTransaction(req.body, String(req.params.id || ''), 'expense');
    await bigquery.query({
      query: `UPDATE \`${PROJECT_ID}.${DATASET_ID}.expenses\`
        SET DATE=@date, DESIGNATION=@description, CHF=@montant_chf, CFA=@montant_cfa,
            PAIEMENT=@type, \`RUBRIQUE DEP\`=@categorie, DEPARTEMENT=@departement, TEAM=@team,
            PHASE=@phase_projet, \` AGENT\`=@agent, FOURNISSEUR=@fournisseur,
            PAYS=@pays, COMMENTAIRES=@commentaire WHERE \`Nr REF\`=@id`,
      params: row, location: DATASET_LOCATION
    });
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Update Expense Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/finance/expenses/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    await bigquery.query({ query: `DELETE FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\` WHERE \`Nr REF\`=@id`, params: { id }, location: DATASET_LOCATION });
    res.json({ success: true, id });
  } catch (error) {
    console.error('Delete Expense Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/finance/income', async (req, res) => {
  try {
    const row = normalizeFinanceTransaction(req.body, `REC-APP-${Date.now()}`, 'income');
    await bigquery.query({
      query: `INSERT INTO \`${PROJECT_ID}.${DATASET_ID}.income\`
        (ID_RECETTE,DATE,DESIGNATION,MONTANT_SAISI,DEVISE_SAISIE,MONTANT_CHF,MONTANT_CFA,
         MODE_ENCAISSEMENT,TYPE_BUDGETAIRE,NATURE_RECETTE,MODE_TAUX,PERIODE_REF,
         TAUX_REF_AUTO,TAUX_FX_SAISI,TAUX_FX_APPLIQUE,DEVISE_CIBLE,SENS_TRESORERIE,
         BU,DEPARTEMENT,PHASE,SOUS_PHASE,TEAM,AGENT,PAYS,COMMENTAIRE,\`Année\`)
        VALUES (@id,@date,@description,@montant_origine,@devise_origine,@montant_chf,@montant_cfa,
         @type,'',@categorie,'Historique exact',@date,@taux_fx,NULL,@taux_fx,
         IF(@devise_origine='CHF','CFA','CHF'),'Entree','',@departement,@phase_projet,'',
         @team,@agent,@pays,@commentaire,@annee)`,
      params: row, location: DATASET_LOCATION
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    console.error('Create Income Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/finance/income/:id', async (req, res) => {
  try {
    const row = normalizeFinanceTransaction(req.body, String(req.params.id || ''), 'income');
    await bigquery.query({
      query: `UPDATE \`${PROJECT_ID}.${DATASET_ID}.income\`
        SET DATE=@date, DESIGNATION=@description, MONTANT_SAISI=@montant_origine,
            DEVISE_SAISIE=@devise_origine, MONTANT_CHF=@montant_chf, MONTANT_CFA=@montant_cfa,
            MODE_ENCAISSEMENT=@type, NATURE_RECETTE=@categorie, MODE_TAUX='Historique exact',
            PERIODE_REF=@date, TAUX_REF_AUTO=@taux_fx, TAUX_FX_APPLIQUE=@taux_fx,
            DEVISE_CIBLE=IF(@devise_origine='CHF','CFA','CHF'), DEPARTEMENT=@departement,
            PHASE=@phase_projet, TEAM=@team, AGENT=@agent, PAYS=@pays,
            COMMENTAIRE=@commentaire, \`Année\`=@annee WHERE ID_RECETTE=@id`,
      params: row, location: DATASET_LOCATION
    });
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Update Income Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/finance/income/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    await bigquery.query({ query: `DELETE FROM \`${PROJECT_ID}.${DATASET_ID}.income\` WHERE ID_RECETTE=@id`, params: { id }, location: DATASET_LOCATION });
    res.json({ success: true, id });
  } catch (error) {
    console.error('Delete Income Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - FINANCE IMMOBILIERE
// ============================================================================

app.get('/api/finance/real-estate', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const transactionsQuery = `
      SELECT
        source_id,
        date_operation,
        designation,
        montant_chf,
        montant_cfa,
        taux_fx,
        part_cheikh_chf,
        remboursement_cheikh_chf,
        type_operation,
        perimetre,
        categorie,
        projet,
        document_ref,
        statut,
        date_operation > CURRENT_DATE() AS est_planifie,
        agent,
        team,
        departement,
        phase_projet,
        source_file,
        source_row,
        enrichi_genspark
      FROM \`${PROJECT_ID}.${DATASET_ID}.fin_immo_propres\`
      ORDER BY date_operation ASC, source_row ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const summaryQuery = `
      SELECT *
      FROM \`${PROJECT_ID}.${DATASET_ID}.fin_immo_synthese\`
      LIMIT 1
    `;
    const options = { location: DATASET_LOCATION };
    const [[transactions], [summaryRows]] = await Promise.all([
      bigquery.query({ ...options, query: transactionsQuery }),
      bigquery.query({ ...options, query: summaryQuery })
    ]);

    res.json({
      success: true,
      data: transactions,
      summary: summaryRows[0] || {},
      count: transactions.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Real Estate Finance Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const normalizeRealEstatePayload = (body, sourceId) => {
  const numberValue = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const dateOperation = String(body.date_operation || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOperation) || !String(body.designation || '').trim()) {
    throw new Error('La date et la designation sont obligatoires.');
  }
  return {
    source_id: sourceId,
    date_operation: dateOperation,
    designation: String(body.designation).trim(),
    montant_chf: numberValue(body.montant_chf),
    montant_cfa: numberValue(body.montant_cfa),
    taux_fx: numberValue(body.taux_fx),
    part_cheikh_chf: numberValue(body.part_cheikh_chf),
    remboursement_cheikh_chf: numberValue(body.remboursement_cheikh_chf),
    type_operation: String(body.type_operation || 'Avance'),
    perimetre: String(body.perimetre || 'Immobilier'),
    categorie: String(body.categorie || 'Autre'),
    projet: String(body.projet || 'Terrain Lac Rose'),
    document_ref: String(body.document_ref || ''),
    statut: String(body.statut || 'En cours'),
    est_planifie: dateOperation > new Date().toISOString().slice(0, 10),
    agent: String(body.agent || ''),
    team: String(body.team || ''),
    departement: String(body.departement || ''),
    phase_projet: String(body.phase_projet || ''),
    source_file: String(body.source_file || 'M3S App'),
    source_row: Number.isFinite(Number(body.source_row)) ? Number(body.source_row) : null,
    enrichi_genspark: Boolean(body.enrichi_genspark)
  };
};

app.post('/api/finance/real-estate', async (req, res) => {
  try {
    const sourceId = `IMM-APP-${Date.now()}`;
    const row = normalizeRealEstatePayload(req.body, sourceId);
    const params = { ...row };
    delete params.source_row;
    const query = `
      INSERT INTO \`${PROJECT_ID}.${DATASET_ID}.fin_immo_propres\` (
        source_id, date_operation, designation, montant_chf, montant_cfa, taux_fx,
        part_cheikh_chf, remboursement_cheikh_chf, type_operation, perimetre,
        categorie, projet, document_ref, statut, est_planifie, agent, team,
        departement, phase_projet, source_file, source_row, enrichi_genspark
      ) VALUES (
        @source_id, DATE(@date_operation), @designation, @montant_chf, @montant_cfa, NULLIF(@taux_fx, 0),
        @part_cheikh_chf, @remboursement_cheikh_chf, @type_operation, @perimetre,
        @categorie, @projet, @document_ref, @statut, @est_planifie, @agent, @team,
        @departement, @phase_projet, @source_file, NULL, @enrichi_genspark
      )
    `;
    await bigquery.query({ query, params, location: DATASET_LOCATION });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    console.error('Create Real Estate Finance Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/finance/real-estate/:id', async (req, res) => {
  try {
    const sourceId = String(req.params.id || '');
    const row = normalizeRealEstatePayload(req.body, sourceId);
    const params = { ...row };
    delete params.source_row;
    const query = `
      UPDATE \`${PROJECT_ID}.${DATASET_ID}.fin_immo_propres\`
      SET
        date_operation = DATE(@date_operation),
        designation = @designation,
        montant_chf = @montant_chf,
        montant_cfa = @montant_cfa,
        taux_fx = NULLIF(@taux_fx, 0),
        part_cheikh_chf = @part_cheikh_chf,
        remboursement_cheikh_chf = @remboursement_cheikh_chf,
        type_operation = @type_operation,
        perimetre = @perimetre,
        categorie = @categorie,
        projet = @projet,
        document_ref = @document_ref,
        statut = @statut,
        est_planifie = @est_planifie,
        agent = @agent,
        team = @team,
        departement = @departement,
        phase_projet = @phase_projet,
        source_file = @source_file,
        enrichi_genspark = @enrichi_genspark
      WHERE source_id = @source_id
    `;
    await bigquery.query({ query, params, location: DATASET_LOCATION });
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Update Real Estate Finance Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/finance/real-estate/:id', async (req, res) => {
  try {
    const sourceId = String(req.params.id || '');
    await bigquery.query({
      query: `DELETE FROM \`${PROJECT_ID}.${DATASET_ID}.fin_immo_propres\` WHERE source_id = @source_id`,
      params: { source_id: sourceId },
      location: DATASET_LOCATION
    });
    res.json({ success: true, source_id: sourceId });
  } catch (error) {
    console.error('Delete Real Estate Finance Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
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

    const preferredQuery = `
      SELECT
        source_id as id,
        source_id,
        nom_document as name,
        nom_document,
        type_document as type,
        type_document,
        categorie as folder,
        categorie,
        proprietaire,
        date_document,
        statut,
        lien,
        taille_ko,
        tags,
        description
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents_propres\`
      ORDER BY source_id
      LIMIT ${limit} OFFSET ${offset}
    `;

    const fallbackQuery = `
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

    const [rows] = await runQueryWithFallback({
      preferredQuery,
      fallbackQuery,
      label: 'Documents'
    });

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
    const preferredQuery = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents_propres\`
    `;

    const fallbackQuery = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.documents_inventory\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'DOC_ID'
    `;
    const [rows] = await runQueryWithFallback({
      preferredQuery,
      fallbackQuery,
      label: 'Documents count'
    });

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

    const preferredQuery = `
      SELECT
        source_id as id,
        source_id,
        source_id as ref,
        article as name,
        article,
        categorie,
        sous_categorie,
        fournisseur,
        quantite as quantity,
        quantite,
        unite,
        achat_chf,
        achat_cfa,
        valeur_chf as price,
        valeur_chf,
        valeur_cfa,
        localisation,
        statut as status,
        statut,
        bu,
        commentaires
      FROM \`${PROJECT_ID}.${DATASET_ID}.stocks_actifs_propres\`
      ORDER BY source_id
      LIMIT ${limit} OFFSET ${offset}
    `;

    const fallbackQuery = `
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

    const [rows] = await runQueryWithFallback({
      preferredQuery,
      fallbackQuery,
      label: 'Inventory'
    });

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
    const preferredQuery = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.stocks_actifs_propres\`
    `;

    const fallbackQuery = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.inventory\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'ID'
    `;
    const [rows] = await runQueryWithFallback({
      preferredQuery,
      fallbackQuery,
      label: 'Inventory count'
    });

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

const normalizeInventoryPayload = (body, sourceId) => {
  const article = String(body.article || body.name || '').trim();
  const categorie = String(body.categorie || '').trim();
  const quantite = numberOrZero(body.quantite ?? body.quantity);
  const achatChf = numberOrZero(body.achat_chf);
  const achatCfa = numberOrZero(body.achat_cfa);
  const valeurChf = numberOrZero(body.valeur_chf ?? body.price);
  const valeurCfa = numberOrZero(body.valeur_cfa);

  if (!article || !categorie) {
    throw new Error("L'article et la categorie sont obligatoires.");
  }
  if (quantite < 0 || achatChf < 0 || achatCfa < 0 || valeurChf < 0 || valeurCfa < 0) {
    throw new Error('Les quantites et montants ne peuvent pas etre negatifs.');
  }

  return {
    source_id: sourceId,
    article,
    categorie,
    sous_categorie: String(body.sous_categorie || '').trim(),
    fournisseur: String(body.fournisseur || '').trim(),
    quantite,
    unite: String(body.unite || '').trim(),
    achat_chf: achatChf,
    achat_cfa: achatCfa,
    valeur_chf: valeurChf,
    valeur_cfa: valeurCfa,
    localisation: String(body.localisation || '').trim(),
    statut: String(body.statut || body.status || 'Neuf').trim(),
    bu: String(body.bu || '').trim(),
    commentaires: String(body.commentaires || body.commentaire || '').trim(),
    source_file: String(body.source_file || 'M3S App').trim()
  };
};

app.post('/api/inventory', async (req, res) => {
  try {
    const row = normalizeInventoryPayload(req.body, `ART-APP-${Date.now()}`);
    await bigquery.query({
      query: `
        INSERT INTO \`${PROJECT_ID}.${DATASET_ID}.stocks_actifs_propres\` (
          source_id, article, categorie, sous_categorie, fournisseur, quantite, unite,
          achat_chf, achat_cfa, valeur_chf, valeur_cfa, localisation, statut, bu,
          commentaires, source_file
        ) VALUES (
          @source_id, @article, @categorie, @sous_categorie, @fournisseur, @quantite, @unite,
          @achat_chf, @achat_cfa, @valeur_chf, @valeur_cfa, @localisation, @statut, @bu,
          @commentaires, @source_file
        )
      `,
      params: row,
      location: DATASET_LOCATION
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    console.error('Create Inventory Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  try {
    const row = normalizeInventoryPayload(req.body, String(req.params.id || ''));
    await bigquery.query({
      query: `
        UPDATE \`${PROJECT_ID}.${DATASET_ID}.stocks_actifs_propres\`
        SET article=@article, categorie=@categorie, sous_categorie=@sous_categorie,
            fournisseur=@fournisseur, quantite=@quantite, unite=@unite,
            achat_chf=@achat_chf, achat_cfa=@achat_cfa, valeur_chf=@valeur_chf,
            valeur_cfa=@valeur_cfa, localisation=@localisation, statut=@statut,
            bu=@bu, commentaires=@commentaires, source_file=@source_file
        WHERE source_id=@source_id
      `,
      params: row,
      location: DATASET_LOCATION
    });
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Update Inventory Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  try {
    const sourceId = String(req.params.id || '');
    await bigquery.query({
      query: `DELETE FROM \`${PROJECT_ID}.${DATASET_ID}.stocks_actifs_propres\` WHERE source_id=@source_id`,
      params: { source_id: sourceId },
      location: DATASET_LOCATION
    });
    res.json({ success: true, source_id: sourceId });
  } catch (error) {
    console.error('Delete Inventory Error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ============================================================================
// API ROUTES - TASKS (CRM)
// ============================================================================

app.get('/api/tasks', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const preferredQuery = `
      SELECT
        source_id as id,
        source_id,
        titre as title,
        titre,
        description,
        statut as status,
        statut,
        priorite as priority,
        priorite,
        responsable,
        module,
        projet,
        date_debut as created_at,
        date_debut,
        date_fin,
        progression,
        team,
        bu,
        annee
      FROM \`${PROJECT_ID}.${DATASET_ID}.taches_propres\`
      ORDER BY date_debut DESC, source_id
      LIMIT ${limit} OFFSET ${offset}
    `;

    const fallbackQuery = `
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

    const [rows] = await runQueryWithFallback({
      preferredQuery,
      fallbackQuery,
      label: 'Tasks'
    });

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
    const preferredQuery = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.taches_propres\`
    `;

    const fallbackQuery = `
      SELECT COUNT(*) as total
      FROM \`${PROJECT_ID}.${DATASET_ID}.bdd_taches\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'Unnamed: 0'
    `;
    const [rows] = await runQueryWithFallback({
      preferredQuery,
      fallbackQuery,
      label: 'Tasks count'
    });

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
    const limit = parseInt(req.query.limit) || 100;

    const preferredHistoryQuery = `
      SELECT
        source_id,
        devise_base as source_currency,
        devise_cible as target_currency,
        taux as rate,
        date_taux as date_updated,
        devise_base,
        devise_cible,
        taux,
        date_taux,
        source_taux,
        commentaire
      FROM \`${PROJECT_ID}.${DATASET_ID}.taux_fx_historiques_propres\`
      ORDER BY date_taux DESC, devise_base, devise_cible
      LIMIT ${limit}
    `;

    const fallbackHistoryQuery = `
      SELECT
        string_field_0 as source_currency,
        string_field_1 as target_currency,
        SAFE_CAST(string_field_2 AS FLOAT64) as rate,
        string_field_3 as date_updated,
        string_field_0 as devise_base,
        string_field_1 as devise_cible,
        SAFE_CAST(string_field_2 AS FLOAT64) as taux,
        string_field_3 as date_taux
      FROM \`${PROJECT_ID}.${DATASET_ID}.fx_rates\`
      WHERE string_field_0 IS NOT NULL
        AND TRIM(string_field_0) != ''
        AND string_field_0 != 'SOURCE'
      ORDER BY string_field_3 DESC
      LIMIT ${limit}
    `;

    const [rows] = await runQueryWithFallback({
      preferredQuery: preferredHistoryQuery,
      fallbackQuery: fallbackHistoryQuery,
      label: 'FX rates'
    });

    let tauxDuJour = {};
    try {
      const [currentRows] = await bigquery.query({
        query: `
          SELECT
            devise_base,
            devise_cible,
            taux,
            date_taux,
            source_taux
          FROM \`${PROJECT_ID}.${DATASET_ID}.taux_fx_du_jour\`
        `,
        location: DATASET_LOCATION
      });

      tauxDuJour = currentRows.reduce((acc, row) => {
        acc[`${row.devise_base}_${row.devise_cible}`] = row.taux;
        return acc;
      }, {});
    } catch (error) {
      if (!isMissingBigQueryTable(error)) {
        throw error;
      }

      tauxDuJour = rows.reduce((acc, row) => {
        const key = `${row.devise_base || row.source_currency}_${row.devise_cible || row.target_currency}`;
        if (!acc[key]) {
          acc[key] = row.taux || row.rate;
        }
        return acc;
      }, {});
    }

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      taux_du_jour: tauxDuJour,
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
        'GET /api/finance/social?limit=100&offset=0',
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

const startServer = async () => {
  try {
    await Promise.all([
      bigquery.query({
        query: `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.expenses\` ADD COLUMN IF NOT EXISTS TEAM STRING`,
        location: DATASET_LOCATION
      }),
      bigquery.query({
        query: `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.expenses\` ADD COLUMN IF NOT EXISTS DEPARTEMENT STRING`,
        location: DATASET_LOCATION
      }),
      bigquery.query({
        query: `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.income\`
          ADD COLUMN IF NOT EXISTS DEPARTEMENT STRING`,
        location: DATASET_LOCATION
      })
    ]);
    console.log('Finance schema ready: TEAM and DEPARTEMENT');
  } catch (error) {
    console.error('Finance schema migration warning:', error.message);
  }

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
};

startServer();


/**
 * M3S ERP Backend - VRAIES DONNÉES BIGQUERY
 * Version ADAPTIVE: teste tous les noms de colonnes possibles
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

let bigquery;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    bigquery = new BigQuery({ projectId: PROJECT_ID, credentials });
    console.log('✅ BigQuery: GOOGLE_CREDENTIALS OK');
  } else {
    bigquery = new BigQuery({
      projectId: PROJECT_ID,
      keyFilename: path.join(__dirname, 'config', 'credentials.json')
    });
    console.log('✅ BigQuery: local credentials.json OK');
  }
} catch (error) {
  console.error('❌ BigQuery init error:', error.message);
  process.exit(1);
}

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0', project: PROJECT_ID, dataset: DATASET_ID });
});

/**
 * Essayer de charger les expenses avec la meilleure approche
 */
app.get('/api/finance/expenses', async (req, res) => {
  try {
    // APPROCHE 1: string_field_X (CSV importé comme strings)
    const query1 = `
      SELECT
        CASE WHEN string_field_1 = 'Nr REF' THEN NULL ELSE string_field_1 END as id,
        CASE WHEN string_field_3 = 'DESIGNATION' THEN NULL ELSE string_field_3 END as description,
        CASE WHEN string_field_4 = 'CHF' THEN NULL ELSE SAFE.FLOAT64(string_field_4) END as amount,
        CASE WHEN string_field_9 = 'RUBRIQUE DEP' THEN NULL ELSE string_field_9 END as category,
        CASE WHEN string_field_2 = 'DATE' THEN NULL ELSE string_field_2 END as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
      WHERE string_field_1 NOT IN ('Nr REF', '', 'nr ref', 'ID')
      LIMIT 100
    `;

    try {
      const [rows] = await bigquery.query({ query: query1, location: 'US' });
      if (rows.length > 0) {
        return res.json({
          success: true,
          data: rows.filter(r => r.id !== null),
          method: 'string_field',
          timestamp: new Date().toISOString()
        });
      }
    } catch (e1) {
      console.log('Approche 1 (string_field) échouée:', e1.message.substring(0, 100));
    }

    // APPROCHE 2: Noms minuscules avec underscores
    const query2 = `
      SELECT
        nr_ref as id,
        designation as description,
        SAFE.FLOAT64(chf) as amount,
        rubrique_dep as category,
        date as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
      LIMIT 100
    `;

    try {
      const [rows] = await bigquery.query({ query: query2, location: 'US' });
      if (rows.length > 0) {
        return res.json({
          success: true,
          data: rows,
          method: 'lowercase_underscore',
          timestamp: new Date().toISOString()
        });
      }
    } catch (e2) {
      console.log('Approche 2 (lowercase) échouée:', e2.message.substring(0, 100));
    }

    // APPROCHE 3: Noms exacts du CSV
    const query3 = `
      SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\` LIMIT 5
    `;

    const [sampleRows] = await bigquery.query({ query: query3, location: 'US' });
    return res.json({
      success: false,
      message: 'Aucune approche ne fonctionne. Données RAW:',
      sample: sampleRows[0] || {},
      columns: Object.keys(sampleRows[0] || {}),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Charger les recettes
 */
app.get('/api/finance/income', async (req, res) => {
  try {
    // APPROCHE 1: string_field_X
    const query1 = `
      SELECT
        CASE WHEN string_field_1 = 'ID_RECETTE' THEN NULL ELSE string_field_1 END as id,
        CASE WHEN string_field_3 = 'DESIGNATION' THEN NULL ELSE string_field_3 END as description,
        CASE WHEN string_field_6 = 'MONTANT_CHF' THEN NULL ELSE SAFE.FLOAT64(string_field_6) END as amount,
        CASE WHEN string_field_10 = 'NATURE_RECETTE' THEN NULL ELSE string_field_10 END as category,
        CASE WHEN string_field_2 = 'DATE' THEN NULL ELSE string_field_2 END as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.income\`
      WHERE string_field_1 NOT IN ('ID_RECETTE', '', 'id_recette', 'ID')
      LIMIT 100
    `;

    try {
      const [rows] = await bigquery.query({ query: query1, location: 'US' });
      if (rows.length > 0) {
        return res.json({
          success: true,
          data: rows.filter(r => r.id !== null),
          method: 'string_field',
          timestamp: new Date().toISOString()
        });
      }
    } catch (e1) {
      console.log('Approche 1 (string_field) échouée:', e1.message.substring(0, 100));
    }

    // APPROCHE 2: Noms minuscules
    const query2 = `
      SELECT
        id_recette as id,
        designation as description,
        SAFE.FLOAT64(montant_chf) as amount,
        nature_recette as category,
        date as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.income\`
      LIMIT 100
    `;

    try {
      const [rows] = await bigquery.query({ query: query2, location: 'US' });
      if (rows.length > 0) {
        return res.json({
          success: true,
          data: rows,
          method: 'lowercase_underscore',
          timestamp: new Date().toISOString()
        });
      }
    } catch (e2) {
      console.log('Approche 2 (lowercase) échouée:', e2.message.substring(0, 100));
    }

    // APPROCHE 3: Données RAW
    const query3 = `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.income\` LIMIT 5`;
    const [sampleRows] = await bigquery.query({ query: query3, location: 'US' });
    return res.json({
      success: false,
      message: 'Aucune approche ne fonctionne. Données RAW:',
      sample: sampleRows[0] || {},
      columns: Object.keys(sampleRows[0] || {}),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ M3S BACKEND v3.0 - ADAPTIVE MODE`);
  console.log(`📡 PORT: ${PORT}`);
  console.log(`🗄️  Dataset: ${PROJECT_ID}.${DATASET_ID}\n`);
});

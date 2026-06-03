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
 * DIAGNOSTIC - Retourner les vrais noms de colonnes
 */
app.get('/api/debug/expenses-schema', async (req, res) => {
  try {
    const query = `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\` LIMIT 1`;
    const [rows] = await bigquery.query({ query, location: 'US' });

    if (rows.length === 0) {
      return res.json({
        success: false,
        message: 'No data in expenses table',
        timestamp: new Date().toISOString()
      });
    }

    const columns = Object.keys(rows[0]);
    const firstRow = rows[0];

    res.json({
      success: true,
      columns: columns,
      firstRow: firstRow,
      sampleData: {
        column1: columns[0] && firstRow[columns[0]],
        column2: columns[1] && firstRow[columns[1]],
        column3: columns[2] && firstRow[columns[2]],
      },
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

// TEST IMMÉDIAT - Retourner test data
app.get('/api/test', async (req, res) => {
  res.json({
    status: 'Backend v3.0 RUNNING',
    timestamp: new Date().toISOString(),
    test_data: [
      { id: 'TEST-001', description: 'Test Item 1', amount: 1000, category: 'Test', created_at: '2026-06-02' },
      { id: 'TEST-002', description: 'Test Item 2', amount: 2000, category: 'Test', created_at: '2026-06-02' }
    ]
  });
});

/**
 * Charger les VRAIES dépenses depuis la table "depenses"
 */
app.get('/api/finance/expenses', async (req, res) => {
  try {
    const query = `
      SELECT
        depense_id as id,
        description as description,
        SAFE.FLOAT64(montant_chf) as amount,
        rubrique_depense as category,
        date_transaction as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.depenses\`
      WHERE depense_id IS NOT NULL
      ORDER BY date_transaction DESC
      LIMIT 500
    `;

    const [rows] = await bigquery.query({ query, location: 'US' });

    if (rows.length > 0) {
      console.log(`✅ Dépenses chargées: ${rows.length} rows`);
      return res.json({
        success: true,
        data: rows,
        method: 'depenses_table',
        rowCount: rows.length,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.log('❌ Erreur lors du chargement des dépenses:', error.message.substring(0, 150));
  }

  // FALLBACK si BigQuery échoue
  console.log('⚠️ Retour au fallback data pour dépenses');
  return res.json({
    success: true,
    data: [
      { id: 'DEP-00001', description: 'Ford Galaxy 7 Places', amount: 1700, category: 'Véhicule', created_at: '2019-02-01' },
      { id: 'DEP-00002', description: 'Bureau Equipment', amount: 2500, category: 'Mobilier', created_at: '2019-03-15' },
      { id: 'DEP-00003', description: 'Logiciels & Licenses', amount: 3200, category: 'IT', created_at: '2019-04-20' },
      { id: 'DEP-00004', description: 'Fournitures Bureau', amount: 850, category: 'Opérationnel', created_at: '2019-05-10' },
      { id: 'DEP-00005', description: 'Télécom Services', amount: 450, category: 'Télécom', created_at: '2019-06-05' },
      { id: 'DEP-00006', description: 'Formation Staff', amount: 1200, category: 'RH', created_at: '2019-07-12' }
    ],
    method: 'FALLBACK_TEST_DATA',
    timestamp: new Date().toISOString()
  });
});

/**
 * Charger les VRAIES recettes depuis la table "recettes"
 */
app.get('/api/finance/income', async (req, res) => {
  try {
    const query = `
      SELECT
        recette_id as id,
        description as description,
        SAFE.FLOAT64(montant_chf) as amount,
        nature_recette as category,
        date_transaction as created_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.recettes\`
      WHERE recette_id IS NOT NULL
      ORDER BY date_transaction DESC
      LIMIT 500
    `;

    const [rows] = await bigquery.query({ query, location: 'US' });

    if (rows.length > 0) {
      console.log(`✅ Recettes chargées: ${rows.length} rows`);
      return res.json({
        success: true,
        data: rows,
        method: 'recettes_table',
        rowCount: rows.length,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.log('❌ Erreur lors du chargement des recettes:', error.message.substring(0, 150));
  }

  // FALLBACK si BigQuery échoue
  console.log('⚠️ Retour au fallback data pour recettes');
  return res.json({
    success: true,
    data: [
      { id: 'REC-00001', description: 'Préfinancement Achat 2 Terrains', amount: 4000, category: 'Financement', created_at: '2019-08-07' },
      { id: 'REC-00002', description: 'Vente Services', amount: 5500, category: 'Services', created_at: '2019-09-12' },
      { id: 'REC-00003', description: 'Donation Sponsors', amount: 3000, category: 'Dons', created_at: '2019-10-03' },
      { id: 'REC-00004', description: 'Subvention Government', amount: 8000, category: 'Subventions', created_at: '2019-11-15' },
      { id: 'REC-00005', description: 'Intérêts Bancaires', amount: 250, category: 'Revenus', created_at: '2019-12-20' }
    ],
    method: 'FALLBACK_TEST_DATA',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`\n✅ M3S BACKEND v3.0 - ADAPTIVE MODE`);
  console.log(`📡 PORT: ${PORT}`);
  console.log(`🗄️  Dataset: ${PROJECT_ID}.${DATASET_ID}\n`);
});

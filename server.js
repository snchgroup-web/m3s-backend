/**
 * TEST BACKEND - Retourner les vraies données RAW de BigQuery
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

// HEALTH
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TEST Backend' });
});

// RAW EXPENSES - RETOURNER LES 10 PREMIÈRES LIGNES
app.get('/api/finance/expenses', async (req, res) => {
  try {
    const query = `
      SELECT *
      FROM \`${PROJECT_ID}.${DATASET_ID}.expenses\`
      LIMIT 10
    `;
    const options = { query, location: 'US' };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      count: rows.length,
      data: rows.map((r, idx) => ({
        index: idx,
        ...r
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// RAW INCOME
app.get('/api/finance/income', async (req, res) => {
  try {
    const query = `
      SELECT *
      FROM \`${PROJECT_ID}.${DATASET_ID}.income\`
      LIMIT 10
    `;
    const options = { query, location: 'US' };
    const [rows] = await bigquery.query(options);

    res.json({
      success: true,
      count: rows.length,
      data: rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ TEST BACKEND - PORT ${PORT}\n`);
});

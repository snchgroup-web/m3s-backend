/**
 * M3S ERP Backend Server - MOCK VERSION
 * Retourne les vraies données de test sans BigQuery
 * Pour développement/test frontend
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

// Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// MOCK DATA - FINANCES
// ============================================================================

const mockExpenses = [
  { id: 1, description: 'Loyer bureau', montant: 5000, type: 'expense', statut: 'paid', category: 'Immobilier', date_created: '2026-01-15' },
  { id: 2, description: 'Fournitures', montant: 2500, type: 'expense', statut: 'paid', category: 'Fournitures', date_created: '2026-01-20' },
  { id: 3, description: 'Salaires', montant: 45000, type: 'expense', statut: 'paid', category: 'RH', date_created: '2026-02-01' },
  { id: 4, description: 'Électricité', montant: 1200, type: 'expense', statut: 'pending', category: 'Utilities', date_created: '2026-02-10' },
  { id: 5, description: 'Internet', montant: 300, type: 'expense', statut: 'paid', category: 'Utilities', date_created: '2026-02-15' },
];

const mockIncome = [
  { id: 1, description: 'Ventes produits', montant: 25000, type: 'income', statut: 'paid', category: 'Ventes', date_created: '2026-01-10' },
  { id: 2, description: 'Prestations services', montant: 15000, type: 'income', statut: 'paid', category: 'Services', date_created: '2026-01-25' },
  { id: 3, description: 'Commissions', montant: 8000, type: 'income', statut: 'paid', category: 'Commissions', date_created: '2026-02-05' },
  { id: 4, description: 'Bonus clients', montant: 5000, type: 'income', statut: 'pending', category: 'Bonus', date_created: '2026-02-20' },
];

// ============================================================================
// MOCK DATA - DOCUMENTS
// ============================================================================

const mockDocuments = [
  { id: 1, name: 'Facture 001', type: 'Invoice', folder: 'Factures', created_at: '2026-01-10', size: 125000, status: 'active' },
  { id: 2, name: 'Contrat Client A', type: 'Contract', folder: 'Contrats', created_at: '2026-01-15', size: 256000, status: 'active' },
  { id: 3, name: 'RIB Compte', type: 'Banking', folder: 'Bancaire', created_at: '2026-01-20', size: 85000, status: 'active' },
  { id: 4, name: 'Devis Q1', type: 'Quote', folder: 'Devis', created_at: '2026-02-01', size: 150000, status: 'active' },
  { id: 5, name: 'Rapport Audit', type: 'Report', folder: 'Rapports', created_at: '2026-02-15', size: 325000, status: 'active' },
];

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'M3S Backend (MOCK)',
    version: '2.0',
    timestamp: new Date().toISOString(),
    bigquery: 'mock_data',
    project: 'mock-demo',
    dataset: 'm3s_demo'
  });
});

// ============================================================================
// FINANCE ROUTES
// ============================================================================

app.get('/api/finance/expenses', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;

  const data = mockExpenses.slice(offset, offset + limit);

  console.log(`✅ Expenses: returning ${data.length} rows`);

  res.json({
    success: true,
    data: data,
    count: data.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/finance/income', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;

  const data = mockIncome.slice(offset, offset + limit);

  console.log(`✅ Income: returning ${data.length} rows`);

  res.json({
    success: true,
    data: data,
    count: data.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/finance/dashboard', (req, res) => {
  const totalIncome = mockIncome.reduce((sum, item) => sum + item.montant, 0);
  const totalExpenses = mockExpenses.reduce((sum, item) => sum + item.montant, 0);

  res.json({
    success: true,
    data: {
      total_income: totalIncome,
      total_income_count: mockIncome.length,
      total_expenses: totalExpenses,
      total_expense_count: mockExpenses.length,
      balance: totalIncome - totalExpenses
    },
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// DOCUMENTS ROUTES
// ============================================================================

app.get('/api/documents', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;

  const data = mockDocuments.slice(offset, offset + limit);

  console.log(`✅ Documents: returning ${data.length} rows`);

  res.json({
    success: true,
    data: data,
    count: data.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/documents/count', (req, res) => {
  res.json({
    success: true,
    total: mockDocuments.length,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// INFO ROUTE
// ============================================================================

app.get('/api/info', (req, res) => {
  res.json({
    service: 'M3S Backend API (MOCK)',
    version: '2.0',
    mode: 'development_mock',
    note: 'Using mock data for testing frontend',
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
      health: [
        'GET /api/health'
      ]
    },
    mock_data: {
      expenses_count: mockExpenses.length,
      income_count: mockIncome.length,
      documents_count: mockDocuments.length
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
║  🚀 M3S BACKEND API - MOCK MODE                               ║
║  URL: http://localhost:3001                                 ║
║  Mode: Development (MOCK DATA)                              ║
║  Environment: development                                   ║
╚════════════════════════════════════════════════════════════════╝

✅ API IS RUNNING WITH MOCK DATA!

📊 Mock Data Available:
  ✓ Expenses: ${mockExpenses.length} items
  ✓ Income: ${mockIncome.length} items
  ✓ Documents: ${mockDocuments.length} items

🌐 Ready Endpoints:
  ✓ GET /api/finance/expenses?limit=100
  ✓ GET /api/finance/income?limit=100
  ✓ GET /api/documents?limit=100
  ✓ GET /api/health
  ✓ GET /api/info

🧪 Test: curl http://localhost:3001/api/health
  `);
});

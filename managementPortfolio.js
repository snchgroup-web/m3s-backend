const seed = require('./referentiels/managementPortfolioSeed.json');
const { assertBigQueryTableContract } = require('./bigQueryTableContract');

const field = (name, type = 'STRING', mode = 'REQUIRED') => ({ name, type, mode });
const MANAGEMENT_TABLE_CONTRACTS = Object.freeze({
  management_portfolios: {
    fields: [
      field('portfolio_id'), field('tenant_id'), field('function_id'), field('title'),
      field('status'), field('confidentiality'), field('responsible_agent_id', 'STRING', 'NULLABLE'),
      field('source_ref'), field('verified_on', 'DATE'), field('created_at', 'TIMESTAMP'),
      field('updated_at', 'TIMESTAMP')
    ],
    partitionField: null,
    clustering: ['tenant_id', 'status']
  },
  management_dossiers: {
    fields: [
      field('dossier_id'), field('tenant_id'), field('portfolio_id'), field('dossier_type'),
      field('display_title'), field('status'), field('confidentiality'),
      field('responsible_agent_id', 'STRING', 'NULLABLE'), field('responsible_status'),
      field('display_state'), field('verified_on', 'DATE'), field('display_next_action'),
      field('source_ref'), field('evidence_ged_ref', 'STRING', 'NULLABLE'), field('record_status'),
      field('created_at', 'TIMESTAMP'), field('updated_at', 'TIMESTAMP')
    ],
    partitionField: 'verified_on',
    clustering: ['tenant_id', 'portfolio_id', 'confidentiality', 'status']
  },
  management_assignments: {
    fields: [
      field('assignment_id'), field('tenant_id'), field('object_type'), field('object_id'),
      field('function_candidate'), field('responsibility'), field('agent_id', 'STRING', 'NULLABLE'),
      field('assignment_status'), field('justification'), field('created_at', 'TIMESTAMP'),
      field('updated_at', 'TIMESTAMP')
    ],
    partitionField: null,
    clustering: ['tenant_id', 'object_type', 'object_id', 'responsibility']
  }
});

const validateIdentifier = (value, label, pattern) => {
  const identifier = String(value || '').trim();
  if (!pattern.test(identifier)) throw new Error(`Invalid BigQuery ${label}`);
  return identifier;
};

const tableReferences = ({ projectId, datasetId }) => {
  const project = validateIdentifier(projectId, 'project identifier', /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  const dataset = validateIdentifier(datasetId, 'dataset identifier', /^[A-Za-z_][A-Za-z0-9_]*$/);
  const table = name => `\`${project}.${dataset}.${name}\``;
  return {
    portfolios: table('management_portfolios'),
    dossiers: table('management_dossiers'),
    assignments: table('management_assignments')
  };
};

const buildManagementPortfolioSchemaStatements = config => {
  const tables = tableReferences(config);
  return [
    `CREATE TABLE IF NOT EXISTS ${tables.portfolios} (
      portfolio_id STRING NOT NULL,
      tenant_id STRING NOT NULL,
      function_id STRING NOT NULL,
      title STRING NOT NULL,
      status STRING NOT NULL,
      confidentiality STRING NOT NULL,
      responsible_agent_id STRING,
      source_ref STRING NOT NULL,
      verified_on DATE NOT NULL,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    ) CLUSTER BY tenant_id, status`,
    `CREATE TABLE IF NOT EXISTS ${tables.dossiers} (
      dossier_id STRING NOT NULL,
      tenant_id STRING NOT NULL,
      portfolio_id STRING NOT NULL,
      dossier_type STRING NOT NULL,
      display_title STRING NOT NULL,
      status STRING NOT NULL,
      confidentiality STRING NOT NULL,
      responsible_agent_id STRING,
      responsible_status STRING NOT NULL,
      display_state STRING NOT NULL,
      verified_on DATE NOT NULL,
      display_next_action STRING NOT NULL,
      source_ref STRING NOT NULL,
      evidence_ged_ref STRING,
      record_status STRING NOT NULL,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    ) PARTITION BY verified_on CLUSTER BY tenant_id, portfolio_id, confidentiality, status`,
    `CREATE TABLE IF NOT EXISTS ${tables.assignments} (
      assignment_id STRING NOT NULL,
      tenant_id STRING NOT NULL,
      object_type STRING NOT NULL,
      object_id STRING NOT NULL,
      function_candidate STRING NOT NULL,
      responsibility STRING NOT NULL,
      agent_id STRING,
      assignment_status STRING NOT NULL,
      justification STRING NOT NULL,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    ) CLUSTER BY tenant_id, object_type, object_id, responsibility`
  ];
};

const buildManagementPortfolioSeedOperations = ({ projectId, datasetId, tenantId = '2sg' }) => {
  const tables = tableReferences({ projectId, datasetId });
  const common = { tenant_id: tenantId, imported_at: new Date().toISOString() };
  const assignments = seed.assignments.map(([assignment_id, object_id, function_candidate, responsibility, justification]) => ({
    assignment_id,
    object_type: 'dossier',
    object_id,
    function_candidate,
    responsibility,
    agent_id: '',
    assignment_status: 'functionally_validated',
    justification
  }));

  return [
    {
      query: `MERGE ${tables.portfolios} target
        USING (SELECT @portfolio_id AS portfolio_id) source
        ON target.tenant_id=@tenant_id AND target.portfolio_id=source.portfolio_id
        WHEN NOT MATCHED THEN INSERT
          (portfolio_id, tenant_id, function_id, title, status, confidentiality,
           responsible_agent_id, source_ref, verified_on, created_at, updated_at)
        VALUES (@portfolio_id, @tenant_id, @function_id, @title, @status, @confidentiality,
          NULLIF(@responsible_agent_id, ''), @source_ref, DATE(@verified_on),
          TIMESTAMP(@imported_at), TIMESTAMP(@imported_at))`,
      params: { ...common, ...seed.portfolio }
    },
    {
      query: `MERGE ${tables.dossiers} target
        USING (SELECT * FROM UNNEST(@rows)) source
        ON target.tenant_id=@tenant_id AND target.dossier_id=source.dossier_id
        WHEN NOT MATCHED THEN INSERT
          (dossier_id, tenant_id, portfolio_id, dossier_type, display_title, status,
           confidentiality, responsible_agent_id, responsible_status, display_state,
           verified_on, display_next_action, source_ref, evidence_ged_ref, record_status,
           created_at, updated_at)
        VALUES (source.dossier_id, @tenant_id, source.portfolio_id, source.dossier_type,
          source.display_title, source.status, source.confidentiality,
          NULLIF(source.responsible_agent_id, ''), source.responsible_status,
          source.display_state, DATE(source.verified_on), source.display_next_action,
          source.source_ref, NULLIF(source.evidence_ged_ref, ''), source.record_status,
          TIMESTAMP(@imported_at), TIMESTAMP(@imported_at))`,
      params: { ...common, rows: seed.dossiers }
    },
    {
      query: `MERGE ${tables.assignments} target
        USING (SELECT * FROM UNNEST(@rows)) source
        ON target.tenant_id=@tenant_id AND target.assignment_id=source.assignment_id
        WHEN NOT MATCHED THEN INSERT
          (assignment_id, tenant_id, object_type, object_id, function_candidate,
           responsibility, agent_id, assignment_status, justification, created_at, updated_at)
        VALUES (source.assignment_id, @tenant_id, source.object_type, source.object_id,
          source.function_candidate, source.responsibility, NULLIF(source.agent_id, ''),
          source.assignment_status, source.justification,
          TIMESTAMP(@imported_at), TIMESTAMP(@imported_at))`,
      params: { ...common, rows: assignments }
    }
  ];
};

const ensureManagementPortfolio = async ({
  bigquery,
  projectId,
  datasetId,
  location = 'US',
  tenantId = '2sg'
}) => {
  const schemaStatements = buildManagementPortfolioSchemaStatements({ projectId, datasetId });
  for (const query of schemaStatements) await bigquery.query({ query, location });
  const dataset = bigquery.dataset(datasetId);
  for (const [tableId, contract] of Object.entries(MANAGEMENT_TABLE_CONTRACTS)) {
    await assertBigQueryTableContract(dataset.table(tableId), contract, 'MANAGEMENT_SCHEMA_INVALID');
  }
  const seedOperations = buildManagementPortfolioSeedOperations({ projectId, datasetId, tenantId });
  for (const operation of seedOperations) {
    await bigquery.query({ ...operation, location });
  }
  return {
    tables: ['management_portfolios', 'management_dossiers', 'management_assignments'],
    portfolioId: seed.portfolio.portfolio_id,
    dossiersImported: seed.dossiers.length,
    assignmentsImported: seed.assignments.length
  };
};

const isMissingTable = error => {
  const message = String(error?.message || '');
  return message.includes('Not found: Table') || message.includes('Not found: Dataset');
};

const createManagementPortfolioHandlers = ({
  bigquery,
  projectId,
  datasetId,
  location = 'US',
  now = () => new Date().toISOString(),
  logger = console
}) => {
  const { dossiers } = tableReferences({ projectId, datasetId });

  const getSummary = async (req, res) => {
    const tenantId = String(req.user?.tenantId || req.user?.organizationId || '').trim();
    if (!tenantId) {
      return res.status(401).json({ success: false, code: 'MANAGEMENT_PORTFOLIO_UNAUTHENTICATED', error: 'Authentication required' });
    }
    try {
      const [rows] = await bigquery.query({
        query: `SELECT
            COUNTIF(status='active' AND record_status='validated_for_integration') AS active_dossiers,
            COUNT(*) AS total_dossiers,
            COUNTIF(confidentiality='restricted') AS restricted_dossiers,
            MAX(verified_on) AS verified_on
          FROM ${dossiers}
          WHERE tenant_id=@tenant_id AND portfolio_id=@portfolio_id`,
        params: { tenant_id: tenantId, portfolio_id: seed.portfolio.portfolio_id },
        location
      });
      const row = rows[0] || {};
      const numeric = value => Number.isFinite(Number(value)) ? Number(value) : null;
      const totalDossiers = numeric(row.total_dossiers);
      if (!totalDossiers) {
        return res.status(503).json({
          success: false,
          code: 'MANAGEMENT_PORTFOLIO_SOURCE_EMPTY',
          error: 'Management portfolio source is not populated'
        });
      }
      return res.json({
        success: true,
        data: {
          portfolio_id: seed.portfolio.portfolio_id,
          active_dossiers: numeric(row.active_dossiers),
          total_dossiers: totalDossiers,
          restricted_dossiers: numeric(row.restricted_dossiers),
          verified_on: row.verified_on?.value || row.verified_on || null
        },
        source: { system: 'bigquery', registry: 'management_dossiers', scope: 'tenant_aggregate' },
        timestamp: now()
      });
    } catch (error) {
      if (isMissingTable(error)) {
        return res.status(503).json({ success: false, code: 'MANAGEMENT_PORTFOLIO_SOURCE_UNAVAILABLE', error: 'Management portfolio source unavailable' });
      }
      logger.error('Management portfolio summary error:', error.message);
      return res.status(500).json({ success: false, code: 'MANAGEMENT_PORTFOLIO_ERROR', error: 'Management portfolio summary unavailable' });
    }
  };

  return { getSummary };
};

module.exports = {
  MANAGEMENT_TABLE_CONTRACTS,
  buildManagementPortfolioSchemaStatements,
  buildManagementPortfolioSeedOperations,
  ensureManagementPortfolio,
  createManagementPortfolioHandlers
};

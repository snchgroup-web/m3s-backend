const assert = require('assert');
const {
  buildManagementPortfolioSchemaStatements,
  buildManagementPortfolioSeedOperations,
  ensureManagementPortfolio,
  createManagementPortfolioHandlers
} = require('../managementPortfolio');

const createBigQuery = outcomes => {
  const calls = [];
  return {
    calls,
    async query(options) {
      calls.push(options);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome || [[]];
    }
  };
};

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});

const config = { projectId: 'project-test', datasetId: 'dataset_test' };

const run = async () => {
  const schemas = buildManagementPortfolioSchemaStatements(config);
  assert.equal(schemas.length, 3);
  assert.match(schemas[0], /management_portfolios/);
  assert.match(schemas[1], /management_dossiers/);
  assert.match(schemas[2], /management_assignments/);
  assert.throws(
    () => buildManagementPortfolioSchemaStatements({ projectId: 'bad`; DROP TABLE x', datasetId: 'dataset_test' }),
    /Invalid BigQuery project identifier/
  );

  const seeds = buildManagementPortfolioSeedOperations({ ...config, tenantId: 'TENANT-2SG' });
  assert.equal(seeds.length, 3);
  assert.equal(seeds[1].params.rows.length, 7);
  assert.equal(seeds[2].params.rows.length, 21);
  assert(seeds[1].params.rows.every(row => row.record_status === 'validated_for_integration'));
  assert(seeds[2].params.rows.every(row => row.assignment_status === 'functionally_validated'));
  assert.match(seeds[0].query, /WHEN NOT MATCHED THEN INSERT/);
  assert.doesNotMatch(seeds[0].query, /WHEN MATCHED/);

  const schemaAndSeedBq = createBigQuery(Array(6).fill([[]]));
  const result = await ensureManagementPortfolio({
    bigquery: schemaAndSeedBq,
    ...config,
    tenantId: 'TENANT-2SG',
    location: 'EU'
  });
  assert.equal(schemaAndSeedBq.calls.length, 6);
  assert(schemaAndSeedBq.calls.every(call => call.location === 'EU'));
  assert.equal(result.dossiersImported, 7);
  assert.equal(result.assignmentsImported, 21);

  const unauthenticatedBq = createBigQuery([]);
  const unauthenticatedResponse = createResponse();
  await createManagementPortfolioHandlers({
    bigquery: unauthenticatedBq,
    ...config,
    logger: { error: () => {} }
  }).getSummary({}, unauthenticatedResponse);
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(unauthenticatedBq.calls.length, 0);

  const summaryBq = createBigQuery([[[{
    active_dossiers: 7,
    total_dossiers: 7,
    restricted_dossiers: 1,
    verified_on: { value: '2026-08-20' }
  }]]]);
  const summaryResponse = createResponse();
  await createManagementPortfolioHandlers({
    bigquery: summaryBq,
    ...config,
    location: 'EU',
    now: () => '2026-08-20T18:00:00.000Z',
    logger: { error: () => {} }
  }).getSummary({ user: { tenantId: 'TENANT-2SG' } }, summaryResponse);
  assert.equal(summaryResponse.statusCode, 200);
  assert.equal(summaryResponse.body.data.active_dossiers, 7);
  assert.equal(summaryResponse.body.data.restricted_dossiers, 1);
  assert.equal(summaryResponse.body.data.verified_on, '2026-08-20');
  assert.equal(summaryBq.calls[0].params.tenant_id, 'TENANT-2SG');
  assert.match(summaryBq.calls[0].query, /COUNTIF\(status='active'/);
  assert.equal('display_title' in summaryResponse.body.data, false);
  assert.equal('source_ref' in summaryResponse.body.data, false);

  const emptyBq = createBigQuery([[[{
    active_dossiers: 0,
    total_dossiers: 0,
    restricted_dossiers: 0,
    verified_on: null
  }]]]);
  const emptyResponse = createResponse();
  await createManagementPortfolioHandlers({
    bigquery: emptyBq,
    ...config,
    logger: { error: () => {} }
  }).getSummary({ user: { tenantId: 'TENANT-2SG' } }, emptyResponse);
  assert.equal(emptyResponse.statusCode, 503);
  assert.equal(emptyResponse.body.code, 'MANAGEMENT_PORTFOLIO_SOURCE_EMPTY');

  const unavailableBq = createBigQuery([new Error('Not found: Table project-test:dataset_test.management_dossiers')]);
  const unavailableResponse = createResponse();
  await createManagementPortfolioHandlers({
    bigquery: unavailableBq,
    ...config,
    logger: { error: () => {} }
  }).getSummary({ user: { tenantId: 'TENANT-2SG' } }, unavailableResponse);
  assert.equal(unavailableResponse.statusCode, 503);
  assert.equal(unavailableResponse.body.code, 'MANAGEMENT_PORTFOLIO_SOURCE_UNAVAILABLE');

  console.log('Management portfolio tests: OK');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

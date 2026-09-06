const { BigQuery } = require('@google-cloud/bigquery');
const { resolveFinanceSources } = require('../financeSources');
const { runIndependentSchemaMigrations, runFinanceSchemaMigrations } = require('../schemaMigrations');

const refusal = code => { const error = new Error(code); error.safeCode = code; throw error; };

function parseGoogleCredentials(rawCredentials) {
  if (!rawCredentials) return null;
  const candidates = [rawCredentials];
  try {
    candidates.push(Buffer.from(rawCredentials, 'base64').toString('utf8'));
  } catch {
    // The raw JSON candidate is still checked below.
  }
  for (const candidate of candidates) {
    try {
      const credentials = JSON.parse(candidate);
      if (credentials?.client_email && credentials?.private_key) return credentials;
    } catch {
      // Try the next representation.
    }
  }
  refusal('GOOGLE_CREDENTIALS_INVALID');
}

function buildBigQueryOptions(projectId, env = process.env) {
  const options = { projectId, autoRetry: false };
  const credentials = parseGoogleCredentials(env.GOOGLE_CREDENTIALS);
  if (credentials) options.credentials = credentials;
  else if (env.GOOGLE_APPLICATION_CREDENTIALS) options.keyFilename = env.GOOGLE_APPLICATION_CREDENTIALS;
  return options;
}

function parseArgs(args) {
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--plan', '--execute', '--non-production', '--application', '--project', '--dataset', '--location',
      '--tenant', '--confirm', '--authorization'].includes(key)
      || Object.hasOwn(flags, key)) refusal('INVALID_ARGUMENTS');
    if (['--plan', '--execute', '--non-production', '--application'].includes(key)) flags[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) refusal('MISSING_ARGUMENT_VALUE');
      flags[key] = value;
    }
  }
  if (flags['--plan'] && flags['--execute']) refusal('CONFLICTING_MODES');
  if (flags['--non-production'] && flags['--application']) refusal('CONFLICTING_TARGET_MODES');
  const execute = flags['--execute'] === true;
  const projectId = flags['--project'] || null;
  const datasetId = flags['--dataset'] || null;
  const location = flags['--location'] || null;
  const tenantId = flags['--tenant'] || null;
  const targetMode = flags['--non-production'] ? 'isolated' : flags['--application'] ? 'application' : null;
  const validProject = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId || '');
  const validLocation = /^(US|EU|[a-z]+(?:-[a-z0-9]+)+)$/.test(location || '');
  if (execute && !targetMode) refusal('MIGRATION_TARGET_MODE_REQUIRED');
  if (execute && targetMode === 'isolated' && (!validProject
    || !/^m3s_migration_test_[a-z0-9_]{1,48}$/.test(datasetId || '')
    || !validLocation)) refusal('ISOLATED_TARGET_REQUIRED');
  if (execute && targetMode === 'application' && (!validProject
    || !/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(datasetId || '')
    || /^m3s_migration_test_/i.test(datasetId || '') || location !== 'US'
    || typeof tenantId !== 'string' || !tenantId.trim() || tenantId !== tenantId.trim()
    || tenantId.length > 200)) {
    refusal('APPLICATION_TARGET_REQUIRED');
  }
  const expectedConfirmation = targetMode === 'application'
    ? `${projectId}.${datasetId}:APPLY-SCHEMA`
    : `${projectId}.${datasetId}`;
  if (execute && flags['--confirm'] !== expectedConfirmation) refusal('EXACT_TARGET_CONFIRMATION_REQUIRED');
  const authorization = flags['--authorization'] || null;
  if (execute && targetMode === 'application'
    && !/^[A-Z][A-Z0-9._/-]{4,95}$/.test(authorization || '')) refusal('AUTHORIZATION_RECORD_REQUIRED');
  if (execute && targetMode === 'isolated' && (authorization || tenantId)) refusal('INVALID_ARGUMENTS');
  if (!execute && (flags['--confirm'] || flags['--non-production'] || flags['--authorization'] || tenantId)) {
    refusal('EXECUTION_FLAGS_REQUIRE_EXECUTE');
  }
  return { execute, targetMode, projectId, datasetId, location, tenantId,
    confirmation: flags['--confirm'] || null, authorization };
}

function assertApplicationAuthorization(config, env = process.env) {
  if (env.M3S_SCHEMA_MIGRATION_TARGET !== `${config.projectId}.${config.datasetId}`
    || env.M3S_SCHEMA_MIGRATION_AUTHORIZATION !== config.authorization
    || env.M3S_SCHEMA_MIGRATION_TENANT !== config.tenantId) {
    refusal('APPLICATION_MIGRATION_NOT_AUTHORIZED');
  }
}

const MIN_TEST_EXPIRATION_MS = 3600000;
const MIN_NEW_TEST_TABLE_EXPIRATION_MS = 2 * MIN_TEST_EXPIRATION_MS;
const MAX_TEST_EXPIRATION_MS = 604800000;

function hasBoundedRemainingExpiration(expirationTime, now) {
  const remaining = Number(expirationTime) - now;
  return Number.isFinite(remaining)
    && remaining >= MIN_TEST_EXPIRATION_MS
    && remaining <= MAX_TEST_EXPIRATION_MS;
}

async function assertIsolatedDataset(client, config, now = Date.now()) {
  const [metadata] = await client.dataset(config.datasetId).getMetadata();
  if (metadata?.datasetReference?.projectId !== config.projectId
    || metadata?.datasetReference?.datasetId !== config.datasetId
    || String(metadata?.location || '').toLowerCase() !== config.location.toLowerCase()
    || metadata?.labels?.purpose !== 'm3s_migration_test') refusal('DATASET_NOT_APPROVED_FOR_MIGRATION_TEST');
  const expiration = Number(metadata.defaultTableExpirationMs);
  if (!Number.isFinite(expiration)
    || expiration < MIN_NEW_TEST_TABLE_EXPIRATION_MS
    || expiration > MAX_TEST_EXPIRATION_MS) {
    refusal('TEST_TABLE_EXPIRATION_REQUIRED');
  }
  const rawPartitionExpiration = metadata.defaultPartitionExpirationMs;
  if (rawPartitionExpiration !== undefined && rawPartitionExpiration !== null
    && rawPartitionExpiration !== '' && Number(rawPartitionExpiration) !== 0) {
    refusal('TEST_PARTITION_EXPIRATION_FORBIDDEN');
  }
  const [tables] = await client.dataset(config.datasetId).getTables({ autoPaginate: true });
  for (const table of tables) {
    const [tableMetadata] = await table.getMetadata();
    if (!hasBoundedRemainingExpiration(tableMetadata?.expirationTime, now)) {
      refusal('EXISTING_TEST_TABLE_EXPIRATION_REQUIRED');
    }
    const rawTablePartitionExpiration = tableMetadata?.timePartitioning?.expirationMs;
    if (rawTablePartitionExpiration !== undefined && rawTablePartitionExpiration !== null
      && rawTablePartitionExpiration !== '' && Number(rawTablePartitionExpiration) !== 0) {
      refusal('EXISTING_TEST_PARTITION_EXPIRATION_FORBIDDEN');
    }
  }
}

async function assertApplicationDataset(client, config) {
  const dataset = client.dataset(config.datasetId);
  const [metadata] = await dataset.getMetadata();
  if (metadata?.datasetReference?.projectId !== config.projectId
    || metadata?.datasetReference?.datasetId !== config.datasetId
    || String(metadata?.location || '').toLowerCase() !== config.location.toLowerCase()) {
    refusal('APPLICATION_DATASET_MISMATCH');
  }
  for (const expiration of [metadata.defaultTableExpirationMs, metadata.defaultPartitionExpirationMs]) {
    if (expiration !== undefined && expiration !== null && expiration !== '' && Number(expiration) !== 0) {
      refusal('APPLICATION_DATASET_RETENTION_INVALID');
    }
  }
  const [tables] = await dataset.getTables({ autoPaginate: true });
  for (const table of tables) {
    const [tableMetadata] = await table.getMetadata();
    for (const expiration of [tableMetadata?.expirationTime, tableMetadata?.timePartitioning?.expirationMs]) {
      if (expiration !== undefined && expiration !== null && expiration !== '' && Number(expiration) !== 0) {
        refusal('APPLICATION_TABLE_RETENTION_INVALID');
      }
    }
  }
}

async function executeMigrations(config, client, {
  runIndependent = runIndependentSchemaMigrations,
  resolveSources = resolveFinanceSources,
  runFinance = runFinanceSchemaMigrations
} = {}) {
  const common = {
    bigquery: client,
    projectId: config.projectId,
    datasetId: config.datasetId,
    location: config.location,
    tenantId: config.targetMode === 'application' ? config.tenantId : 'synthetic-migration-test'
  };
  const results = await runIndependent(common);
  const financeSources = await resolveSources({ bigquery: client, datasetId: config.datasetId });
  results.finance = await runFinance({ ...common, financeSources });
  return results;
}

async function run(config, client, env = process.env) {
  if (!config.execute) refusal('EXECUTION_REQUIRED');
  if (config.targetMode === 'application') {
    assertApplicationAuthorization(config, env);
    await assertApplicationDataset(client, config);
  } else {
    await assertIsolatedDataset(client, config);
  }
  return executeMigrations(config, client);
}

async function main(args = process.argv.slice(2), {
  log = value => console.log(JSON.stringify(value)),
  createClient = projectId => new BigQuery(buildBigQueryOptions(projectId)),
  env = process.env
} = {}) {
  try {
    const config = parseArgs(args);
    if (!config.execute) {
      const application = config.targetMode === 'application';
      log({ mode: 'plan', targetMode: application ? 'application' : 'isolated',
        executionAuthorized: false, cloudAccess: false,
        requires: application
          ? ['Existing application dataset; this command never creates one.',
            'Exact project, dataset, US location and tenant.',
            'No automatic expiration on the dataset, its existing tables or their partitions.',
            'Matching M3S_SCHEMA_MIGRATION_TARGET, _TENANT and _AUTHORIZATION values.',
            'Exact :APPLY-SCHEMA confirmation plus --execute --application.']
          : ['Existing m3s_migration_test_* dataset labelled purpose=m3s_migration_test.',
            'Whole-table expiration only: new tables expire in 2 hours to 7 days; existing tables retain at least 1 hour.',
            'Synthetic Finance source tables and an isolated migration identity.',
            'Exact target confirmation plus --execute --non-production.'],
        excludes: ['Dataset creation', 'IAM changes', 'Budget activation', 'real data'] });
      return 0;
    }
    if (config.targetMode === 'application') assertApplicationAuthorization(config, env);
    const result = await run(config, createClient(config.projectId), env);
    log({ status: 'passed', target: `${config.projectId}.${config.datasetId}`, result });
    return 0;
  } catch (error) {
    log({ status: 'refused', reason: error.safeCode || 'MIGRATION_CHECK_FAILED' });
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = {
  parseArgs,
  parseGoogleCredentials,
  buildBigQueryOptions,
  assertApplicationAuthorization,
  assertIsolatedDataset,
  assertApplicationDataset,
  executeMigrations,
  run,
  main
};

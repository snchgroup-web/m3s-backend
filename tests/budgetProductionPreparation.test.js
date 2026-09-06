const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const express = require('express');
const cors = require('cors');
const { createCorsOriginValidator, createCorsErrorHandler } = require('../corsPolicy');
const {
  inspectProductionAuthConfiguration,
  assertProductionAuthConfiguration,
  hasStrongSigningSecret,
  createEnvironmentSigningKeyProvider,
  isSharedSigningKeyProvider,
  selectSigningKeyProvider,
  signJwtToken,
  verifyJwtToken,
  hasValidPasswordCredential,
  normalizeLoginIdentifier,
  findUniqueLoginAccount,
  resolveAccountIdentity
} = require('../authConfiguration');
const {
  createBudgetObservabilityMiddleware,
  isBudgetRoute,
  normalizeBudgetRoute
} = require('../budgetObservability');
const { createBudgetBodyMiddleware } = require('../financeBudgetDrafts');
const { buildFinanceSchemaStatements } = require('../schemaMigrations');
const { ADMINISTRATION_TABLE_CONTRACTS,
  ensureAdministrationRegistrySchema } = require('../administrationRegistries');
const { MANAGEMENT_TABLE_CONTRACTS, ensureManagementPortfolio } = require('../managementPortfolio');
const { TABLE_SCHEMA, createIntelligenceDashboardRepository,
  ensureIntelligenceDashboardSchema } = require('../intelligenceDashboard');
const {
  parseArgs,
  parseGoogleCredentials,
  buildBigQueryOptions,
  assertApplicationAuthorization,
  assertIsolatedDataset,
  assertApplicationDataset,
  executeMigrations,
  main
} = require('../scripts/runSchemaMigrations');

const JWT_SECRET_FIXTURE = crypto.createHash('sha256').update('m3s-unit-test-signing-key-fixture')
  .digest('base64url');
const signingSecret = seed => crypto.createHash('sha256').update(seed).digest('base64url');
const signingKeysEnv = (activeKeyId = 'budget-2026-09', keys = [
  { id: activeKeyId, secret: JWT_SECRET_FIXTURE }
]) => ({ M3S_AUTH_SIGNING_KEYS_JSON: JSON.stringify({ activeKeyId, keys }) });

const validCredential = overrides => ({
  email: 'owner@example.test',
  passwordHash: Buffer.alloc(32, 1).toString('base64'),
  passwordSalt: Buffer.alloc(16, 2).toString('base64'),
  passwordIterations: 120000,
  ...overrides
});

test('production authentication requires a persistent shared signing key provider only for Budget', () => {
  const env = { NODE_ENV: 'production', API_REQUIRE_AUTH: 'true', FINANCE_BUDGET_DRAFTS_ENABLED: 'true',
    ...signingKeysEnv() };
  const provider = createEnvironmentSigningKeyProvider(env);
  const hashed = [validCredential({ id: 'owner' })];
  const plaintextFixture = ['test', 'only'].join('-');
  const invalidBase64Fixture = '*'.repeat(5);
  assert.equal(isSharedSigningKeyProvider(provider), true);
  assert.deepEqual(inspectProductionAuthConfiguration({
    NODE_ENV: 'production', API_REQUIRE_AUTH: 'true', JWT_SECRET: JWT_SECRET_FIXTURE
  }, []), { ready: true, reason: 'production-budget-disabled' });
  assert.deepEqual(inspectProductionAuthConfiguration(env, hashed, provider),
    { ready: true, reason: 'ready' });
  assert.equal(inspectProductionAuthConfiguration({ ...env, API_REQUIRE_AUTH: 'false' }, hashed,
    provider).reason,
    'authentication-disabled');
  assert.equal(inspectProductionAuthConfiguration(env, hashed).reason, 'signing-secret-not-ready');
  assert.equal(inspectProductionAuthConfiguration({ ...env, JWT_SECRET: JWT_SECRET_FIXTURE }, hashed,
    provider).reason, 'operator-signing-secret-forbidden');
  const periodicUnicodeSecret = Array.from({ length: 8 }, (_, index) => String.fromCodePoint(0x1f600 + index))
    .join('').repeat(4);
  const unicodeSecret = Array.from({ length: 8 }, (_, index) => String.fromCodePoint(0x1f600 + index))
    .join('');
  const longPeriodicSecret = 'abcdefghijklmnopq'.repeat(2);
  const truncatedPeriodicSecret = '0123456789'.repeat(4).slice(0, 32);
  const suffixedPeriodicSecret = `${'1234567890abcdef'.repeat(2)}X`;
  const shortPrefixPeriodicSecret = `${'abcd'.repeat(8)}WXYZ`;
  const prefixedRepeatedRunSecret = `${'ABCD1234'}${'x'.repeat(24)}`;
  const repeatedByteBlock = Buffer.from([
    0, 7, 2, 13, 5, 15, 1, 10, 4, 12, 3, 14, 6, 11, 8, 9,
    0, 7, 2, 13, 5, 15, 1, 10, 4, 12, 3, 14, 6, 11, 8, 9
  ]).toString('base64url');
  const humanRepeatedSecret = Buffer.from('abcabcabcqwertyuiopasdfghjklzxcv').toString('base64url');
  for (const weakSecret of [' '.repeat(32), 'x'.repeat(32), '12345678'.repeat(4),
    'abcdefghijklmnopqrstuvwxyzABCDEF',
    periodicUnicodeSecret, longPeriodicSecret, truncatedPeriodicSecret, suffixedPeriodicSecret,
    shortPrefixPeriodicSecret, prefixedRepeatedRunSecret, unicodeSecret,
    Buffer.alloc(31, 1).toString('base64url'), Buffer.alloc(33, 1).toString('base64url'),
    Buffer.alloc(32, 1).toString('base64'), Buffer.alloc(32).toString('base64url'),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url'),
    repeatedByteBlock, humanRepeatedSecret]) {
    assert.equal(hasStrongSigningSecret(weakSecret), false);
  }
  assert.equal(hasStrongSigningSecret(JWT_SECRET_FIXTURE), true);
  assert.equal(inspectProductionAuthConfiguration(env,
    [{ email: 'owner@example.test', password: plaintextFixture }], provider).reason,
    'plaintext-password-present');
  assert.equal(inspectProductionAuthConfiguration(env, [validCredential({ email: undefined })], provider).reason,
    'login-identifier-missing');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ email: '   ' })], provider).reason,
    'login-identifier-missing');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ passwordHash: 'AA==' })], provider).reason, 'password-credential-invalid');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ passwordSalt: invalidBase64Fixture })], provider).reason, 'password-credential-invalid');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ passwordIterations: 119999 })], provider).reason, 'password-credential-invalid');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ passwordIterations: 1000001 })], provider).reason, 'password-credential-invalid');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential(), validCredential({ email: ' OWNER@example.test ' })], provider).reason,
    'login-identifier-duplicate');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ id: 'shared', email: 'one@example.test', tenantId: 'org-a' }),
      validCredential({ id: 'shared', email: 'two@example.test', tenantId: 'org-a' })], provider).reason,
  'account-principal-duplicate');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ id: 42 })], provider).reason, 'account-principal-invalid');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ id: 'x'.repeat(201) })], provider).reason, 'account-principal-invalid');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ tenantId: 'x'.repeat(201) })], provider).reason, 'account-principal-invalid');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ id: ' owner ' })], provider).reason, 'account-principal-invalid');
  assert.equal(inspectProductionAuthConfiguration(env,
    [validCredential({ tenantId: ' org ' })], provider).reason, 'account-principal-invalid');
  assert.equal(inspectProductionAuthConfiguration({ ...env, M3S_DEFAULT_TENANT_ID: ' org ' },
    [validCredential()], provider).reason, 'account-principal-invalid');
  assert.equal(hasValidPasswordCredential(validCredential()), true);
  assert.equal(normalizeLoginIdentifier(' Owner@Example.Test '), 'owner@example.test');
  const uniqueAccount = validCredential({ email: 'owner@example.test' });
  assert.equal(findUniqueLoginAccount([uniqueAccount], ' OWNER@example.test '), uniqueAccount);
  assert.equal(findUniqueLoginAccount([
    uniqueAccount,
    validCredential({ email: 'Owner@example.test', id: 'other' })
  ], 'owner@example.test'), null);
  assert.equal(findUniqueLoginAccount([uniqueAccount], 'missing@example.test'), null);
  assert.equal(resolveAccountIdentity({ email: ' Owner@Example.Test ' }, {}), null);
  assert.throws(() => assertProductionAuthConfiguration(env, [], provider), error => (
    error.code === 'AUTH_CONFIGURATION_NOT_READY' && error.safeReason === 'no-active-account'
  ));
  assert.deepEqual(inspectProductionAuthConfiguration({ NODE_ENV: 'test' }, []),
    { ready: true, reason: 'non-production' });
  const previewEnv = {
    NODE_ENV: 'test',
    API_REQUIRE_AUTH: 'true',
    JWT_SECRET: JWT_SECRET_FIXTURE,
    FINANCE_BUDGET_DRAFTS_ENABLED: 'true'
  };
  assert.equal(inspectProductionAuthConfiguration(previewEnv,
    [validCredential({ id: 'shared', email: 'one@example.test' }),
      validCredential({ id: 'shared', email: 'two@example.test' })]).reason,
  'account-principal-duplicate');
  assert.deepEqual(inspectProductionAuthConfiguration(previewEnv,
    [{ id: 'preview-owner', email: 'preview@example.test', password: plaintextFixture }]),
  { ready: true, reason: 'non-production-budget-identities-ready' });
  assert.equal(inspectProductionAuthConfiguration(previewEnv,
    [validCredential({ passwordHash: 'AA==' })]).reason, 'password-credential-invalid');
  assert.equal(inspectProductionAuthConfiguration(previewEnv,
    [{ id: 'preview-owner', email: 'preview@example.test' }]).reason,
  'password-credential-missing');
  assert.deepEqual(inspectProductionAuthConfiguration({}, []),
    { ready: false, reason: 'runtime-environment-not-explicit' });
});

test('shared signing key provider supports bounded multi-instance rotation and retirement', () => {
  const oldKey = { id: 'budget-2026-08', secret: signingSecret('old-shared-signing-key') };
  const newKey = { id: 'budget-2026-09', secret: signingSecret('new-shared-signing-key') };
  const now = () => Date.parse('2026-09-06T12:00:00Z');
  const stagedProvider = createEnvironmentSigningKeyProvider(signingKeysEnv(oldKey.id, [oldKey, newKey]));
  const oldToken = signJwtToken({ id: 'user-a', tenantId: 'org-a' }, { provider: stagedProvider, now });
  const activatedEnv = signingKeysEnv(newKey.id, [newKey, oldKey]);
  const firstInstance = createEnvironmentSigningKeyProvider(activatedEnv);
  const secondInstance = createEnvironmentSigningKeyProvider(activatedEnv);
  assert.equal(verifyJwtToken(oldToken, { provider: firstInstance, now }).id, 'user-a');
  const newToken = signJwtToken({ id: 'user-a', tenantId: 'org-a' }, { provider: firstInstance, now });
  assert.equal(verifyJwtToken(newToken, { provider: secondInstance, now }).tenantId, 'org-a');
  const retiredProvider = createEnvironmentSigningKeyProvider(signingKeysEnv(newKey.id, [newKey]));
  assert.equal(verifyJwtToken(oldToken, { provider: retiredProvider, now }), null);
  assert.equal(verifyJwtToken(newToken, { provider: retiredProvider, now }).id, 'user-a');
});

test('legacy-to-shared cutover signs explicitly and verifies both formats', () => {
  const provider = createEnvironmentSigningKeyProvider(signingKeysEnv());
  const now = () => Date.parse('2026-09-06T12:00:00Z');
  const legacyEnv = { JWT_SECRET: JWT_SECRET_FIXTURE };
  assert.equal(selectSigningKeyProvider(legacyEnv, provider), null);
  const legacyToken = signJwtToken({ id: 'legacy' }, {
    provider: selectSigningKeyProvider(legacyEnv, provider), fallbackSecret: JWT_SECRET_FIXTURE, now
  });
  const sharedEnv = { ...legacyEnv, M3S_AUTH_SIGNING_MODE: 'shared' };
  assert.equal(selectSigningKeyProvider(sharedEnv, provider), provider);
  const sharedToken = signJwtToken({ id: 'shared' }, {
    provider: selectSigningKeyProvider(sharedEnv, provider), fallbackSecret: JWT_SECRET_FIXTURE, now
  });
  const dualVerification = { provider, fallbackSecret: JWT_SECRET_FIXTURE,
    allowLegacyFallback: true, now };
  assert.equal(verifyJwtToken(legacyToken, dualVerification).id, 'legacy');
  assert.equal(verifyJwtToken(sharedToken, dualVerification).id, 'shared');
  assert.equal(verifyJwtToken(legacyToken, { provider, now }), null);
  assert.equal(verifyJwtToken(sharedToken, { provider, now }).id, 'shared');
  assert.equal(selectSigningKeyProvider({}, provider), provider);
  assert.equal(selectSigningKeyProvider({ M3S_AUTH_SIGNING_MODE: 'invalid' }, provider), null);
});

test('shared signing key provider rejects malformed rings and unknown key ids', () => {
  const key = { id: 'budget-2026-09', secret: JWT_SECRET_FIXTURE };
  const malformed = [
    {},
    { M3S_AUTH_SIGNING_KEYS_JSON: '{' },
    { M3S_AUTH_SIGNING_KEYS_JSON: JSON.stringify({ activeKeyId: key.id, keys: [], extra: true }) },
    signingKeysEnv('missing-key', [key]),
    signingKeysEnv(key.id, [key, { ...key, id: 'duplicate-secret' }]),
    signingKeysEnv(key.id, [key, { ...key, secret: signingSecret('different') }]),
    signingKeysEnv(key.id, [{ ...key, secret: 'x'.repeat(43) }]),
    signingKeysEnv(key.id, Array.from({ length: 4 }, (_, index) => ({
      id: `budget-key-${index}`,
      secret: signingSecret(`key-${index}`)
    })))
  ];
  for (const env of malformed) assert.equal(createEnvironmentSigningKeyProvider(env), null);
  const provider = createEnvironmentSigningKeyProvider(signingKeysEnv());
  const token = signJwtToken({ id: 'user-a' }, { provider, now: () => 1000000 });
  const [encodedHeader, body, signature] = token.split('.');
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  const unknownHeader = Buffer.from(JSON.stringify({ ...header, kid: 'unknown-key' })).toString('base64url');
  assert.equal(verifyJwtToken(`${unknownHeader}.${body}.${signature}`, {
    provider, now: () => 1000000
  }), null);
  assert.throws(() => signJwtToken({ id: 'user-a' }, { provider, lifetimeSeconds: 59 }));
  const excessiveLifetimeBody = Buffer.from(JSON.stringify({ id: 'user-a', iat: 1000,
    exp: 1000 + 24 * 60 * 60 + 1 })).toString('base64url');
  const excessiveSignature = crypto.createHmac('sha256', JWT_SECRET_FIXTURE)
    .update(`${encodedHeader}.${excessiveLifetimeBody}`).digest('base64url');
  assert.equal(verifyJwtToken(`${encodedHeader}.${excessiveLifetimeBody}.${excessiveSignature}`, {
    provider, now: () => 1000000
  }), null);
});

test('JWT secret generator only emits a value accepted by production validation', () => {
  const generated = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts',
    'generate-jwt-secret.js')], { encoding: 'utf8' }).trim();
  assert.equal(generated.length, 43);
  assert.equal(hasStrongSigningSecret(generated), true);
});

test('budget observability normalizes routes and excludes payload and identity data', async () => {
  assert.equal(isBudgetRoute('/API/FINANCE/BUDGET-DRAFTS/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
  assert.equal(isBudgetRoute('/api/finance/budget-drafts-private/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
  assert.equal(normalizeBudgetRoute('/capabilities'), '/api/finance/budget-drafts/capabilities');
  assert.equal(normalizeBudgetRoute('/API/FINANCE/BUDGET-DRAFTS/CAPABILITIES'),
    '/api/finance/budget-drafts/capabilities');
  assert.equal(normalizeBudgetRoute('/API/FINANCE/BUDGET-DRAFTS/CAPABILITIES/'),
    '/api/finance/budget-drafts/capabilities');
  assert.equal(normalizeBudgetRoute('/API/FINANCE/BUDGET-DRAFTS/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    '/api/finance/budget-drafts/:id');
  assert.equal(normalizeBudgetRoute('/API/FINANCE/BUDGET-DRAFTS/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/'),
    '/api/finance/budget-drafts/:id');
  assert.equal(normalizeBudgetRoute('/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    '/api/finance/budget-drafts/:id');
  const logs = [];
  const app = express();
  app.use('/api/finance/budget-drafts', createBudgetObservabilityMiddleware({
    revision: 'candidate',
    now: (() => { let value = 100; return () => value += 5; })(),
    idGenerator: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    logger: { error(message) { logs.push({ level: 'error', message }); } }
  }));
  app.get('/api/finance/budget-drafts/:id', (_req, res) => res.status(503).json({
    success: false,
    code: 'BUDGET_STORAGE_UNAVAILABLE',
    amount: '999999 CHF',
    ownerId: 'private-user'
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/finance/budget-drafts/${id}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-request-id'), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.length, 1);
    assert.equal(typeof logs[0].message, 'string');
    const event = JSON.parse(logs[0].message);
    assert.deepEqual(event, {
      event: 'budget_request',
      timestamp: '1970-01-01T00:00:00.110Z',
      correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      outcome: 'completed',
      method: 'GET',
      route: '/api/finance/budget-drafts/:id',
      status: 503,
      durationMs: 5,
      code: 'BUDGET_STORAGE_UNAVAILABLE',
      revision: 'candidate'
    });
    const serialized = logs[0].message;
    assert(!serialized.includes(id));
    assert(!serialized.includes('999999'));
    assert(!serialized.includes('private-user'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('budget observability records an aborted response once', () => {
  const logs = [];
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: false,
    set() {},
    json(body) { return body; }
  });
  createBudgetObservabilityMiddleware({
    now: (() => { let value = 100; return () => value += 5; })(),
    idGenerator: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    logger: { warn(message) { logs.push(message); } }
  })({ method: 'PUT', path: '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, res, () => {});
  res.statusCode = 409;
  res.json({ success: false, code: 'BUDGET_CONFLICT' });
  res.emit('close');
  res.emit('finish');
  assert.equal(logs.length, 1);
  const event = JSON.parse(logs[0]);
  assert.equal(event.outcome, 'aborted');
  assert.equal(event.status, 499);
  assert.equal(event.code, 'CLIENT_CLOSED_REQUEST');
  assert.equal(event.timestamp, '1970-01-01T00:00:00.110Z');
});

test('budget observability records CORS failures before route handlers', async () => {
  const logs = [];
  const app = express();
  app.use('/api/finance/budget-drafts', createBudgetObservabilityMiddleware({
    revision: 'candidate',
    idGenerator: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    logger: { info(message) { logs.push(message); } }
  }));
  app.use(cors({ origin: createCorsOriginValidator(['https://allowed.example']) }));
  app.use('/api/finance/budget-drafts', createBudgetBodyMiddleware());
  app.get('/api/finance/budget-drafts/capabilities', (_req, res) => res.json({ success: true }));
  app.use(createCorsErrorHandler());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/finance/budget-drafts/capabilities`,
      { headers: { Origin: 'https://rejected.example' } }
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('x-request-id'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0]);
    assert.equal(event.route, '/api/finance/budget-drafts/capabilities');
    assert.equal(event.status, 403);
    assert.equal(event.code, 'CORS_ORIGIN_REJECTED');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('schema migration command is plan-only by default and refuses production-shaped targets', async () => {
  assert.deepEqual(parseArgs([]), { execute: false, targetMode: null, projectId: null, datasetId: null,
    location: null, tenantId: null, confirmation: null, authorization: null });
  assert.throws(() => parseArgs(['--execute', '--non-production', '--project', 'mon-projet-data-2sg',
    '--dataset', 'm3s_2sg', '--location', 'US', '--confirm', 'mon-projet-data-2sg.m3s_2sg']),
  error => error.safeCode === 'ISOLATED_TARGET_REQUIRED');
  const config = parseArgs(['--execute', '--non-production', '--project', 'mon-projet-data-2sg',
    '--dataset', 'm3s_migration_test_candidate', '--location', 'US',
    '--confirm', 'mon-projet-data-2sg.m3s_migration_test_candidate']);
  assert.equal(config.execute, true);
  let clientCreated = false; const logs = [];
  assert.equal(await main([], { log: value => logs.push(value), createClient() { clientCreated = true; } }), 0);
  assert.equal(clientCreated, false);
  assert.equal(logs[0].cloudAccess, false);
});

test('isolated migration refuses existing tables outside the bounded retention window', async () => {
  const now = 1000000000;
  const config = { projectId: 'test-project', datasetId: 'm3s_migration_test_candidate', location: 'US' };
  const datasetMetadata = { datasetReference: { projectId: config.projectId, datasetId: config.datasetId },
    location: 'US', labels: { purpose: 'm3s_migration_test' }, defaultTableExpirationMs: '7200000' };
  const client = (expirationTime, {
    datasetOverrides = {},
    partitionExpirationMs
  } = {}) => ({
    dataset() {
      return {
        async getMetadata() { return [{ ...datasetMetadata, ...datasetOverrides }]; },
        async getTables(options) {
          assert.deepEqual(options, { autoPaginate: true });
          return [[{ async getMetadata() {
            return [{ expirationTime, ...(partitionExpirationMs === undefined ? {} : {
              timePartitioning: { expirationMs: partitionExpirationMs }
            }) }];
          } }]];
        }
      };
    }
  });
  await assert.doesNotReject(assertIsolatedDataset(client(now + 3600000, {
    datasetOverrides: { defaultPartitionExpirationMs: '0' },
    partitionExpirationMs: '0'
  }), config, now));
  await assert.rejects(assertIsolatedDataset(client(now + 3600000, {
    datasetOverrides: { defaultTableExpirationMs: '3600000' }
  }), config, now), error => error.safeCode === 'TEST_TABLE_EXPIRATION_REQUIRED');
  for (const defaultPartitionExpirationMs of ['3600000', '604800001', 'invalid']) {
    await assert.rejects(assertIsolatedDataset(client(now + 3600000, {
      datasetOverrides: { defaultPartitionExpirationMs }
    }), config, now), error => error.safeCode === 'TEST_PARTITION_EXPIRATION_FORBIDDEN');
  }
  for (const expirationTime of [undefined, now + 3599999, now + 604800001]) {
    await assert.rejects(assertIsolatedDataset(client(expirationTime), config, now),
      error => error.safeCode === 'EXISTING_TEST_TABLE_EXPIRATION_REQUIRED');
  }
  for (const partitionExpirationMs of ['3600000', '604800001', 'invalid']) {
    await assert.rejects(assertIsolatedDataset(client(now + 3600000, { partitionExpirationMs }),
      config, now), error => error.safeCode === 'EXISTING_TEST_PARTITION_EXPIRATION_FORBIDDEN');
  }
});

test('application migration path requires matching target authorization before cloud access', async () => {
  const authorization = 'CHG-BUDGET-001';
  const target = 'mon-projet-data-2sg.m3s_2sg';
  const args = ['--execute', '--application', '--project', 'mon-projet-data-2sg', '--dataset', 'm3s_2sg',
    '--location', 'US', '--tenant', '2sg', '--confirm', `${target}:APPLY-SCHEMA`,
    '--authorization', authorization];
  const config = parseArgs(args);
  assert.equal(config.targetMode, 'application');
  assert.throws(() => parseArgs(args.map(value => value === 'US' ? 'EU' : value)),
    error => error.safeCode === 'APPLICATION_TARGET_REQUIRED');
  assert.equal(parseArgs(args.map(value => value === '2sg' ? 'TENANT-2SG' : value)).tenantId, 'TENANT-2SG');
  assert.throws(() => parseArgs(args.map(value => value === '2sg' ? ' 2sg ' : value)),
    error => error.safeCode === 'APPLICATION_TARGET_REQUIRED');
  assert.throws(() => assertApplicationAuthorization(config, {}),
    error => error.safeCode === 'APPLICATION_MIGRATION_NOT_AUTHORIZED');
  assert.doesNotThrow(() => assertApplicationAuthorization(config, {
    M3S_SCHEMA_MIGRATION_TARGET: target,
    M3S_SCHEMA_MIGRATION_TENANT: '2sg',
    M3S_SCHEMA_MIGRATION_AUTHORIZATION: authorization
  }));
  let clientCreated = false; const logs = [];
  assert.equal(await main(args, {
    env: {},
    log: value => logs.push(value),
    createClient() { clientCreated = true; }
  }), 1);
  assert.equal(clientCreated, false);
  assert.equal(logs[0].reason, 'APPLICATION_MIGRATION_NOT_AUTHORIZED');
});

test('application migration refuses automatic dataset retention', async () => {
  const config = { projectId: 'test-project', datasetId: 'application_data', location: 'US' };
  const client = (overrides, tableMetadata = {}) => ({ dataset() { return {
    async getMetadata() { return [{
      datasetReference: { projectId: config.projectId, datasetId: config.datasetId },
      location: config.location,
      ...overrides
    }]; },
    async getTables(options) {
      assert.deepEqual(options, { autoPaginate: true });
      return [[{ async getMetadata() { return [tableMetadata]; } }]];
    }
  }; } });
  await assert.doesNotReject(assertApplicationDataset(client({}), config));
  for (const overrides of [
    { defaultTableExpirationMs: '5184000000' },
    { defaultPartitionExpirationMs: '5184000000' },
    { defaultTableExpirationMs: 'invalid' }
  ]) {
    await assert.rejects(assertApplicationDataset(client(overrides), config),
      error => error.safeCode === 'APPLICATION_DATASET_RETENTION_INVALID');
  }
  for (const tableMetadata of [
    { expirationTime: '5184000000' },
    { timePartitioning: { expirationMs: '5184000000' } },
    { expirationTime: 'invalid' }
  ]) {
    await assert.rejects(assertApplicationDataset(client({}, tableMetadata), config),
      error => error.safeCode === 'APPLICATION_TABLE_RETENTION_INVALID');
  }
});

test('independent schemas run before Finance source resolution and survive its failure', async () => {
  const calls = [];
  const config = { targetMode: 'application', projectId: 'test-project', datasetId: 'application_data',
    location: 'US', tenantId: '2sg' };
  await assert.rejects(() => executeMigrations(config, {}, {
    async runIndependent(options) {
      calls.push(['independent', options.tenantId]);
      return { administration: { ready: true }, management: { ready: true }, intelligence: { ready: true } };
    },
    async resolveSources() {
      calls.push(['finance-resolution']);
      throw new Error('Finance sources unavailable');
    },
    async runFinance() { calls.push(['finance']); }
  }), /Finance sources unavailable/);
  assert.deepEqual(calls, [['independent', '2sg'], ['finance-resolution']]);
});

test('Administration and Management migrations validate every existing table contract', async () => {
  const metadataFor = contract => ({
    schema: { fields: contract.fields.map(item => ({ ...item })) },
    ...(contract.partitionField
      ? { timePartitioning: { type: 'DAY', field: contract.partitionField } }
      : {}),
    clustering: { fields: [...contract.clustering] }
  });
  const clientFor = (contracts, invalidTable = null) => {
    const queries = [];
    const bigquery = {
      async query(options) { queries.push(options); return [[]]; },
      dataset() {
        return { table(tableId) {
          return { async getMetadata() {
            const metadata = metadataFor(contracts[tableId]);
            if (tableId === invalidTable) metadata.schema.fields = metadata.schema.fields.slice(1);
            return [metadata];
          } };
        } };
      }
    };
    return { bigquery, queries };
  };

  const administration = clientFor(ADMINISTRATION_TABLE_CONTRACTS);
  assert.deepEqual(await ensureAdministrationRegistrySchema({ bigquery: administration.bigquery,
    projectId: 'test-project', datasetId: 'application_data', location: 'US' }), {
    tables: Object.keys(ADMINISTRATION_TABLE_CONTRACTS)
  });
  assert.equal(administration.queries.length, 3);
  const staleAdministration = clientFor(ADMINISTRATION_TABLE_CONTRACTS, 'administration_resources');
  await assert.rejects(ensureAdministrationRegistrySchema({ bigquery: staleAdministration.bigquery,
    projectId: 'test-project', datasetId: 'application_data', location: 'US' }),
  error => error.code === 'ADMINISTRATION_SCHEMA_INVALID');

  const management = clientFor(MANAGEMENT_TABLE_CONTRACTS);
  await ensureManagementPortfolio({ bigquery: management.bigquery, projectId: 'test-project',
    datasetId: 'application_data', location: 'US', tenantId: '2sg' });
  assert.equal(management.queries.length, 6);
  const staleManagement = clientFor(MANAGEMENT_TABLE_CONTRACTS, 'management_dossiers');
  await assert.rejects(ensureManagementPortfolio({ bigquery: staleManagement.bigquery,
    projectId: 'test-project', datasetId: 'application_data', location: 'US', tenantId: '2sg' }),
  error => error.code === 'MANAGEMENT_SCHEMA_INVALID');
  assert.equal(staleManagement.queries.length, 3);
});

test('schema migration credentials support Railway JSON, base64, key files and ADC without cloud access', () => {
  const privateKeyFixture = ['fixture', 'value'].join('-');
  const serviceAccount = { client_email: 'migration@example.test', private_key: privateKeyFixture };
  assert.deepEqual(parseGoogleCredentials(JSON.stringify(serviceAccount)), serviceAccount);
  assert.deepEqual(parseGoogleCredentials(Buffer.from(JSON.stringify(serviceAccount)).toString('base64')),
    serviceAccount);
  assert.deepEqual(buildBigQueryOptions('test-project', {
    GOOGLE_CREDENTIALS: JSON.stringify(serviceAccount)
  }), { projectId: 'test-project', autoRetry: false, credentials: serviceAccount });
  assert.deepEqual(buildBigQueryOptions('test-project', {
    GOOGLE_APPLICATION_CREDENTIALS: 'C:/isolated/key.json'
  }), { projectId: 'test-project', autoRetry: false, keyFilename: 'C:/isolated/key.json' });
  assert.deepEqual(buildBigQueryOptions('test-project', {}), {
    projectId: 'test-project', autoRetry: false
  });
  assert.throws(() => buildBigQueryOptions('test-project', { GOOGLE_CREDENTIALS: 'invalid' }),
    error => error.safeCode === 'GOOGLE_CREDENTIALS_INVALID');
});

test('Finance DDL is identifier-safe and absent from normal server startup', () => {
  const statements = buildFinanceSchemaStatements({ projectId: 'test-project', datasetId: 'migration_test',
    incomeTable: 'income', expensesTable: 'expenses' });
  assert.equal(statements.length, 3);
  assert(statements.every(statement => statement.startsWith('ALTER TABLE `test-project.migration_test.')));
  assert.throws(() => buildFinanceSchemaStatements({ projectId: 'test', datasetId: 'safe',
    incomeTable: 'income`; DROP TABLE x', expensesTable: 'expenses' }), /Invalid BigQuery/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /ensureAdministrationRegistrySchema|ensureManagementPortfolio|ALTER TABLE/);
  assert.match(server, /resolveBudgetStorageConfig/);
  assert.match(server, /selectSigningKeyProvider\(process\.env, CONFIGURED_AUTH_KEY_PROVIDER\)/);
  assert.match(server, /revision: APP_REVISION/);
  assert.match(server, /findUniqueLoginAccount\(users, loginIdentifier\)/);
  assert.match(server, /isBudgetRoute\(req\.path\)/);
  assert.match(server, /normalizeBudgetRoute\(req\.path\)/);
});

test('Intelligence runtime fails closed when its table is missing and migration owns creation', async () => {
  let creates = 0;
  const table = { async exists() { return [false]; } };
  const dataset = { table() { return table; }, async createTable() { creates++; return [{}]; } };
  const bigquery = { dataset() { return dataset; }, async query() { assert.fail('Runtime query must not run'); } };
  const repository = createIntelligenceDashboardRepository({ bigquery, projectId: 'test',
    datasetId: 'isolated', location: 'US' });
  await assert.rejects(() => repository.getLatestMetadata(), error => error.code === 'INTELLIGENCE_SCHEMA_MISSING');
  assert.equal(creates, 0);
  assert.deepEqual(await ensureIntelligenceDashboardSchema({ bigquery, datasetId: 'isolated', location: 'US' }),
    { created: true, table: 'intelligence_dashboard_editions' });
  assert.equal(creates, 1);
});

test('Intelligence migration and runtime require the exact existing table schema', async () => {
  let queries = 0;
  const metadata = { schema: { fields: TABLE_SCHEMA.map(field => ({ ...field })) } };
  const table = { async exists() { return [true]; }, async getMetadata() { return [metadata]; } };
  const bigquery = {
    dataset() { return { table() { return table; }, async createTable() { assert.fail('Must not recreate'); } }; },
    async query() { queries++; return [[]]; }
  };
  assert.deepEqual(await ensureIntelligenceDashboardSchema({ bigquery, datasetId: 'isolated', location: 'US' }),
    { created: false, table: 'intelligence_dashboard_editions' });
  const repository = createIntelligenceDashboardRepository({ bigquery, projectId: 'test',
    datasetId: 'isolated', location: 'US' });
  await repository.requireTable();
  metadata.schema.fields = metadata.schema.fields.slice(1);
  await assert.rejects(
    ensureIntelligenceDashboardSchema({ bigquery, datasetId: 'isolated', location: 'US' }),
    error => error.code === 'INTELLIGENCE_SCHEMA_INVALID'
  );
  await assert.rejects(repository.getLatestMetadata(), error => error.code === 'INTELLIGENCE_SCHEMA_INVALID');
  assert.equal(queries, 0);
});

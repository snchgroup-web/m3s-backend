const crypto = require('crypto');
const {
  hasStrongSigningSecret,
  isProductionSigningSecretProvision,
  resolveAccountIdentity
} = require('./authConfiguration');
const express = require('express');
const { PERMISSIONS, permissionsForUser, permissionsForAccount } = require('./financeAccess');

const MAX_BYTES = 512 * 1024;
const MAX_VERSION = 1000000;
const MIN_TEST_EXPIRATION_MS = 60 * 60 * 1000;
const MIN_NEW_TEST_TABLE_EXPIRATION_MS = 2 * MIN_TEST_EXPIRATION_MS;
const MAX_TEST_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () => { throw new Error('Invalid budget draft'); };
const text = (value, max, required = false) => typeof value === 'string'
  && value.length <= max && (!required || Boolean(value.trim()));
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;

function validateBudget(budget) {
  if (!fields(budget, ['title', 'entity', 'year', 'revision', 'rate', 'rateSource', 'rateDate', 'rows'])
    || !text(budget.title, 120, true) || !text(budget.entity, 120, true)
    || typeof budget.year !== 'string' || !/^\d{4}$/.test(budget.year)
    || Number(budget.year) < 2000 || Number(budget.year) > 2100
    || !Number.isInteger(budget.revision) || budget.revision < 0 || budget.revision > MAX_VERSION
    || !text(budget.rate, 24) || !text(budget.rateSource, 200) || !text(budget.rateDate, 10)
    || !Array.isArray(budget.rows) || budget.rows.length > 100) fail();
  if (budget.rate.trim()) {
    const rate = Number(budget.rate.trim().replace(',', '.'));
    if (!/^\d+(?:[.,]\d{1,6})?$/.test(budget.rate.trim()) || rate <= 0 || rate > 1e6
      || !budget.rateSource.trim() || !date(budget.rateDate)) fail();
  } else if (budget.rateSource || budget.rateDate) fail();
  const ids = new Set();
  for (const row of budget.rows) {
    if (!fields(row, ['id', 'label', 'kind', 'direction', 'currency', 'months'])
      || !text(row.id, 64, true) || ids.has(row.id) || !text(row.label, 120, true)
      || !['operating', 'investment', 'financing'].includes(row.kind)
      || !['in', 'out'].includes(row.direction) || !['CHF', 'CFA'].includes(row.currency)
      || !Array.isArray(row.months) || row.months.length !== 12
      || !row.months.every(value => text(value, 24) && (!value.trim()
        || (/^\d+(?:[.,]\d{1,2})?$/.test(value.trim()) && Number(value.trim().replace(',', '.')) <= 1e9)))) fail();
    ids.add(row.id);
  }
  // Store decimal strings unchanged: missing months, explicit zero and currency remain distinct.
  const json = JSON.stringify(budget);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) fail();
  return json;
}

function tableReferences(projectId, datasetId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId || '')
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId || '')) throw new Error('Invalid BigQuery identifier');
  const ref = name => `\`${projectId}.${datasetId}.${name}\``;
  return { drafts: ref('finance_budget_drafts_v1'), events: ref('finance_budget_draft_events_v1') };
}

function buildBudgetSchemaStatements({ projectId, datasetId }) {
  const { drafts, events } = tableReferences(projectId, datasetId);
  return [
    `CREATE TABLE IF NOT EXISTS ${drafts} (
      id STRING NOT NULL, tenant_id STRING NOT NULL, owner_user_id STRING NOT NULL,
      version INT64 NOT NULL, title STRING NOT NULL, entity STRING NOT NULL, year STRING NOT NULL,
      budget_json STRING NOT NULL, created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL
    ) PARTITION BY DATE(created_at) CLUSTER BY tenant_id, owner_user_id, id`,
    `CREATE TABLE IF NOT EXISTS ${events} (
      id STRING NOT NULL, draft_id STRING NOT NULL, tenant_id STRING NOT NULL,
      actor_user_id STRING NOT NULL, version INT64 NOT NULL, action STRING NOT NULL,
      occurred_at TIMESTAMP NOT NULL
    ) PARTITION BY DATE(occurred_at) CLUSTER BY tenant_id, actor_user_id, draft_id`
  ];
}

const BUDGET_TABLE_REQUIREMENTS = {
  finance_budget_drafts_v1: {
    fields: [
      ['id', 'STRING'], ['tenant_id', 'STRING'], ['owner_user_id', 'STRING'], ['version', 'INTEGER'],
      ['title', 'STRING'], ['entity', 'STRING'], ['year', 'STRING'], ['budget_json', 'STRING'],
      ['created_at', 'TIMESTAMP'], ['updated_at', 'TIMESTAMP']
    ],
    partitionField: 'created_at',
    clusteringFields: ['tenant_id', 'owner_user_id', 'id']
  },
  finance_budget_draft_events_v1: {
    fields: [
      ['id', 'STRING'], ['draft_id', 'STRING'], ['tenant_id', 'STRING'], ['actor_user_id', 'STRING'],
      ['version', 'INTEGER'], ['action', 'STRING'], ['occurred_at', 'TIMESTAMP']
    ],
    partitionField: 'occurred_at',
    clusteringFields: ['tenant_id', 'actor_user_id', 'draft_id']
  }
};

function hasExpectedBudgetTableSchema(metadata, requirement) {
  const actualFields = metadata?.schema?.fields;
  if (!Array.isArray(actualFields) || actualFields.length !== requirement.fields.length) return false;
  const byName = new Map(actualFields.map(field => [field.name, field]));
  const canonicalType = value => value === 'INT64' ? 'INTEGER' : value;
  const fieldsMatch = requirement.fields.every(([name, type]) => {
    const field = byName.get(name);
    return field && canonicalType(field.type) === type && field.mode === 'REQUIRED';
  });
  const partitioningMatches = metadata?.timePartitioning?.type === 'DAY'
    && metadata.timePartitioning.field === requirement.partitionField;
  const clusteringMatches = Array.isArray(metadata?.clustering?.fields)
    && metadata.clustering.fields.length === requirement.clusteringFields.length
    && metadata.clustering.fields.every((field, index) => field === requirement.clusteringFields[index]);
  return fieldsMatch && partitioningMatches && clusteringMatches;
}

function resolveBudgetStorageConfig(env = {}, {
  projectId = env.BIGQUERY_PROJECT || 'mon-projet-data-2sg',
  applicationDatasetId = env.BIGQUERY_DATASET || 'm3s_2sg',
  defaultLocation = 'US',
  signingSecretProvision = null
} = {}) {
  const datasetId = String(env.FINANCE_BUDGET_DATASET || '').trim();
  const location = String(env.FINANCE_BUDGET_LOCATION || defaultLocation).trim();
  const validDataset = /^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId);
  const validLocation = /^(US|EU|[a-z]+(?:-[a-z0-9]+)+)$/i.test(location);
  const dedicated = validDataset && datasetId !== applicationDatasetId;
  const productionApproved = env.NODE_ENV !== 'production'
    || (String(env.FINANCE_BUDGET_APPROVED_DATASET || '').trim() === datasetId
      && !/^m3s_migration_test_/i.test(datasetId));
  const production = env.NODE_ENV === 'production';
  const configuredSigningSecret = typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
  const signingSecretReady = production
    ? !configuredSigningSecret && isProductionSigningSecretProvision(signingSecretProvision)
    : hasStrongSigningSecret(env.JWT_SECRET);
  const authReady = env.API_REQUIRE_AUTH === 'true' && signingSecretReady;
  const requested = env.FINANCE_BUDGET_DRAFTS_ENABLED === 'true';
  const enabled = requested && authReady && dedicated && validLocation && productionApproved;
  let reason = 'ready';
  if (!requested) reason = 'feature-disabled';
  else if (!authReady) reason = 'authentication-not-ready';
  else if (!validDataset) reason = 'budget-dataset-missing-or-invalid';
  else if (!dedicated) reason = 'budget-dataset-not-isolated';
  else if (!validLocation) reason = 'budget-location-invalid';
  else if (!productionApproved) reason = 'budget-dataset-not-approved';
  return {
    projectId,
    datasetId: validDataset ? datasetId : null,
    location: validLocation ? location : defaultLocation,
    requested,
    enabled,
    reason
  };
}

async function assertBudgetDatasetPolicy({ bigquery, storage, env = {}, now = () => Date.now() }) {
  const reject = safeReason => {
    const error = new Error('Budget dataset policy is not ready');
    error.code = 'BUDGET_DATASET_POLICY_NOT_READY';
    error.safeReason = safeReason;
    throw error;
  };
  if (!storage?.enabled || !storage.datasetId || !bigquery?.dataset) {
    return reject(storage?.reason || 'budget-dataset-metadata-unavailable');
  }
  let dataset;
  let metadata;
  try {
    dataset = bigquery.dataset(storage.datasetId);
    [metadata] = await dataset.getMetadata();
  } catch (_error) {
    return reject('budget-dataset-metadata-unavailable');
  }
  const production = env.NODE_ENV === 'production';
  const purpose = String(metadata?.labels?.purpose || '').toLowerCase();
  const expectedPurpose = production ? 'm3s_budget_production' : 'm3s_budget_test';
  const metadataLocation = String(metadata?.location || '').toUpperCase();
  const expectedLocation = String(storage.location || '').toUpperCase();
  const tableExpiration = Number(metadata?.defaultTableExpirationMs);
  const partitionExpiration = Number(metadata?.defaultPartitionExpirationMs);
  const validExpiration = production
    ? (!Number.isFinite(tableExpiration) || tableExpiration <= 0)
      && (!Number.isFinite(partitionExpiration) || partitionExpiration <= 0)
    : Number.isFinite(tableExpiration)
      && tableExpiration >= MIN_NEW_TEST_TABLE_EXPIRATION_MS
      && tableExpiration <= MAX_TEST_EXPIRATION_MS
      && (!Number.isFinite(partitionExpiration) || partitionExpiration <= 0);
  if (metadataLocation !== expectedLocation) return reject('budget-dataset-location-mismatch');
  if (purpose !== expectedPurpose) return reject('budget-dataset-purpose-mismatch');
  if (!validExpiration) return reject('budget-dataset-retention-invalid');
  try {
    for (const [tableName, requirement] of Object.entries(BUDGET_TABLE_REQUIREMENTS)) {
      const table = dataset.table(tableName);
      const [exists] = await table.exists();
      if (!exists) return reject('budget-table-missing');
      const [tableMetadata] = await table.getMetadata();
      const expiresAt = Number(tableMetadata?.expirationTime);
      const partitionsExpireAfter = Number(tableMetadata?.timePartitioning?.expirationMs);
      if (production) {
        if ((Number.isFinite(expiresAt) && expiresAt > 0)
          || (Number.isFinite(partitionsExpireAfter) && partitionsExpireAfter > 0)) {
          return reject('budget-table-retention-invalid');
        }
      } else {
        const remainingTableLifetime = expiresAt - now();
        const hasTableExpiration = Number.isFinite(expiresAt) && expiresAt > 0;
        const boundedTableExpiration = Number.isFinite(remainingTableLifetime)
          && remainingTableLifetime >= MIN_TEST_EXPIRATION_MS
          && remainingTableLifetime <= MAX_TEST_EXPIRATION_MS;
        if (!hasTableExpiration || !boundedTableExpiration
          || (Number.isFinite(partitionsExpireAfter) && partitionsExpireAfter > 0)) {
          return reject('budget-table-retention-invalid');
        }
      }
      if (!hasExpectedBudgetTableSchema(tableMetadata, requirement)) {
        return reject('budget-table-schema-invalid');
      }
    }
  } catch (error) {
    if (error?.code === 'BUDGET_DATASET_POLICY_NOT_READY') throw error;
    return reject('budget-table-metadata-unavailable');
  }
  return { ready: true, purpose: expectedPurpose };
}

function budgetDraftsEnabled(env, options) {
  return resolveBudgetStorageConfig(env, options).enabled;
}

function createBudgetBodyMiddleware() {
  return [
    (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      if (['POST', 'PUT'].includes(req.method) && !req.is('application/json')) {
        return res.status(415).json({ success: false, code: 'BUDGET_JSON_REQUIRED' });
      }
      return next();
    },
    express.json({ limit: '512kb' }),
    (error, req, res, next) => {
      if (!['entity.parse.failed', 'entity.too.large'].includes(error?.type)) {
        return next(error);
      }
      // Parser errors can contain the submitted body. Do not pass them to global logging.
      return res.status(error.status === 413 ? 413 : 400).json({ success: false, code: 'BUDGET_INVALID_BODY' });
    }
  ];
}

function createBudgetAccountMiddleware({ getAccounts, defaultTenantId = '2sg' }) {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const account = getAccounts().find(candidate => {
      if (!candidate || candidate.active === false) return false;
      const identity = resolveAccountIdentity(candidate, { M3S_DEFAULT_TENANT_ID: defaultTenantId });
      return identity?.id === req.user?.id && identity.tenantId === req.user?.tenantId;
    });
    if (!account) return res.status(401).json({ success: false, code: 'BUDGET_UNAUTHENTICATED' });
    // Re-read Finance rights from the current account, not just the possibly older signed token.
    req.user = { ...req.user, permissions: permissionsForAccount(account), financePermissionsExplicit: true };
    return next();
  };
}

function createBudgetDraftHandlers({ bigquery, projectId, datasetId, location = 'US', enabled = false,
  disabledReason = 'feature-disabled', idGenerator = () => crypto.randomUUID(), logger = console }) {
  const safeReasons = new Set(['feature-disabled', 'authentication-not-ready',
    'budget-dataset-missing-or-invalid', 'budget-dataset-not-isolated', 'budget-location-invalid',
    'budget-dataset-not-approved']);
  const safeDisabledReason = safeReasons.has(disabledReason) ? disabledReason : 'configuration-invalid';
  const { drafts, events } = tableReferences(projectId, datasetId);
  const scope = 'tenant_id = @tenantId AND owner_user_id = @ownerId';
  const event = action => `INSERT INTO ${events}
    (id, draft_id, tenant_id, actor_user_id, version, action, occurred_at)
    VALUES (@eventId, @id, @tenantId, @ownerId, @nextVersion, '${action}', CURRENT_TIMESTAMP());`;
  const respond = (res, status, code, extra = {}) => res.status(status).json({ success: false, code, ...extra });
  const identity = (req, res, write = false) => {
    res.set('Cache-Control', 'no-store');
    const user = req.user;
    if (!text(user?.id, 200, true) || !text(user?.tenantId, 200, true)) {
      respond(res, 401, 'BUDGET_UNAUTHENTICATED'); return null;
    }
    const permissions = permissionsForUser(user);
    if (!permissions.includes(PERMISSIONS.READ) || (write && !permissions.includes(PERMISSIONS.WRITE))) {
      respond(res, 403, 'BUDGET_FORBIDDEN'); return null;
    }
    return { tenantId: user.tenantId, ownerId: user.id };
  };
  const active = res => {
    if (enabled === true) return true;
    respond(res, 503, 'BUDGET_STORAGE_DISABLED', { reason: safeDisabledReason }); return false;
  };
  const query = async (sql, params) => {
    const [rows] = await bigquery.query({ query: sql, params, location, useLegacySql: false });
    return rows;
  };
  const unavailable = (res, error, draftId, writing = false) => {
    const concurrent = /concurrent update|transaction.*aborted|serialization/i.test(String(error?.message || ''));
    // Never log SQL, payloads, user identifiers or the BigQuery error message.
    logger.error('Budget storage request failed', { code: concurrent ? 'conflict' : 'unavailable' });
    return respond(res, concurrent ? 409 : 503, concurrent ? 'BUDGET_CONFLICT' : 'BUDGET_STORAGE_UNAVAILABLE',
      writing ? { draftId, reconcileRequired: true } : {});
  };
  const validId = (req, res) => {
    if (typeof req.params?.id === 'string' && ID_PATTERN.test(req.params.id)) return true;
    respond(res, 400, 'BUDGET_INVALID_ID'); return false;
  };
  const validBody = (req, res, update) => {
    try {
      if (!fields(req.body, update ? ['budget', 'expectedVersion'] : ['budget'])) fail();
      if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_BYTES) fail();
      if (update && (!Number.isInteger(req.body.expectedVersion)
        || req.body.expectedVersion < 1 || req.body.expectedVersion >= MAX_VERSION)) fail();
      return validateBudget(req.body.budget);
    } catch { respond(res, 400, 'BUDGET_INVALID_PAYLOAD'); return null; }
  };
  const strictInt = (value, fallback, max, min = 0) => {
    if (value === undefined) return fallback;
    return typeof value === 'string' && /^\d{1,5}$/.test(value) && Number(value) >= min
      && Number(value) <= max ? Number(value) : null;
  };
  const summary = row => {
    const version = Number(row.version);
    if (!ID_PATTERN.test(row.id) || !Number.isInteger(version) || version < 1 || version > MAX_VERSION) fail();
    return { id: row.id, version, title: row.title, entity: row.entity, year: row.year,
      createdAt: row.created_at?.value || row.created_at, updatedAt: row.updated_at?.value || row.updated_at,
      scope: 'organization', status: 'draft', access: 'owner-only' };
  };
  return {
    capabilities(req, res) {
      if (!identity(req, res)) return;
      return res.json({ success: true, enabled: enabled === true, scope: 'organization', access: 'owner-only',
        personalEnabled: false, canWrite: enabled === true && permissionsForUser(req.user).includes(PERMISSIONS.WRITE),
        reason: enabled === true ? 'ready' : safeDisabledReason });
    },
    async list(req, res) {
      const actor = identity(req, res);
      if (!actor || !active(res)) return;
      const limit = strictInt(req.query?.limit, 20, 50, 1);
      const offset = strictInt(req.query?.offset, 0, 10000);
      if (limit === null || offset === null || Object.keys(req.query || {}).some(k => !['limit', 'offset'].includes(k))) {
        return respond(res, 400, 'BUDGET_INVALID_QUERY');
      }
      try {
        const rows = await query(`SELECT id, version, title, entity, year, created_at, updated_at
          FROM ${drafts} WHERE ${scope} ORDER BY updated_at DESC, id LIMIT @limit OFFSET @offset`,
        { ...actor, limit: limit + 1, offset });
        return res.json({ success: true, data: rows.slice(0, limit).map(summary), hasMore: rows.length > limit });
      } catch (error) { return unavailable(res, error); }
    },
    async get(req, res) {
      const actor = identity(req, res);
      if (!actor || !active(res) || !validId(req, res)) return;
      try {
        const rows = await query(`SELECT id, version, title, entity, year, created_at, updated_at, budget_json
          FROM ${drafts} WHERE ${scope} AND id = @id LIMIT 2`, { ...actor, id: req.params.id });
        if (!rows.length) return respond(res, 404, 'BUDGET_NOT_FOUND');
        if (rows.length !== 1) fail();
        const budget = JSON.parse(rows[0].budget_json);
        validateBudget(budget);
        return res.json({ success: true, data: { ...summary(rows[0]), budget } });
      } catch (error) { return unavailable(res, error); }
    },
    async create(req, res) {
      const actor = identity(req, res, true);
      if (!actor || !active(res)) return;
      const budgetJson = validBody(req, res, false);
      if (!budgetJson) return;
      const id = idGenerator();
      try {
        const result = await query(`BEGIN TRANSACTION;
          INSERT INTO ${drafts} (id, tenant_id, owner_user_id, version, title, entity, year, budget_json, created_at, updated_at)
          VALUES (@id, @tenantId, @ownerId, 1, @title, @entity, @year, @budgetJson, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());
          ${event('created')}
          COMMIT TRANSACTION;
          SELECT 'saved' AS outcome, 1 AS version;`, { ...actor, id, eventId: idGenerator(), nextVersion: 1,
          title: req.body.budget.title, entity: req.body.budget.entity, year: req.body.budget.year, budgetJson });
        if (result[0]?.outcome !== 'saved') fail();
        return res.status(201).json({ success: true, data: { id, version: 1, scope: 'organization', status: 'draft', access: 'owner-only' } });
      } catch (error) { return unavailable(res, error, id, true); }
    },
    async update(req, res) {
      const actor = identity(req, res, true);
      if (!actor || !active(res) || !validId(req, res)) return;
      const budgetJson = validBody(req, res, true);
      if (!budgetJson) return;
      const id = req.params.id;
      const nextVersion = req.body.expectedVersion + 1;
      try {
        // Existence, compare-and-swap and audit are in one transaction, never a pre-read followed by an unconditional write.
        const result = await query(`DECLARE outcome STRING DEFAULT 'missing';
          DECLARE matches INT64;
          BEGIN TRANSACTION;
          SET matches = (SELECT COUNT(*) FROM ${drafts} WHERE ${scope} AND id = @id);
          ASSERT matches <= 1 AS 'Duplicate budget draft';
          IF matches = 1 THEN
            UPDATE ${drafts} SET budget_json = @budgetJson, title = @title, entity = @entity, year = @year,
              version = @nextVersion, updated_at = CURRENT_TIMESTAMP()
              WHERE ${scope} AND id = @id AND version = @expectedVersion;
            IF @@row_count = 1 THEN
              ${event('updated')}
              SET outcome = 'saved';
            ELSE
              SET outcome = 'conflict';
            END IF;
          END IF;
          COMMIT TRANSACTION;
          SELECT outcome, IF(outcome = 'saved', @nextVersion, NULL) AS version;`, {
          ...actor, id, eventId: idGenerator(), nextVersion, expectedVersion: req.body.expectedVersion,
          title: req.body.budget.title, entity: req.body.budget.entity, year: req.body.budget.year, budgetJson
        });
        if (result[0]?.outcome === 'missing') return respond(res, 404, 'BUDGET_NOT_FOUND');
        if (result[0]?.outcome === 'conflict') return respond(res, 409, 'BUDGET_CONFLICT');
        if (result[0]?.outcome !== 'saved' || Number(result[0]?.version) !== nextVersion) fail();
        return res.json({ success: true, data: { id, version: nextVersion, scope: 'organization', status: 'draft', access: 'owner-only' } });
      } catch (error) { return unavailable(res, error, id, true); }
    }
  };
}

module.exports = { validateBudget, buildBudgetSchemaStatements, resolveBudgetStorageConfig, budgetDraftsEnabled,
  assertBudgetDatasetPolicy,
  createBudgetBodyMiddleware, createBudgetAccountMiddleware, createBudgetDraftHandlers };

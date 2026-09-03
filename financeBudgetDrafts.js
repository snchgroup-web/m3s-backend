const crypto = require('crypto');
const express = require('express');
const { PERMISSIONS, permissionsForUser, permissionsForAccount } = require('./financeAccess');

const MAX_BYTES = 512 * 1024;
const MAX_VERSION = 1000000;
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

function budgetDraftsEnabled(env) {
  return env.FINANCE_BUDGET_DRAFTS_ENABLED === 'true' && env.API_REQUIRE_AUTH === 'true'
    && typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length >= 32
    && env.JWT_SECRET !== 'm3s-development-secret-change-me';
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
      // Parser errors can contain the submitted body. Do not pass them to global logging.
      return res.status(error.status === 413 ? 413 : 400).json({ success: false, code: 'BUDGET_INVALID_BODY' });
    }
  ];
}

function createBudgetAccountMiddleware({ getAccounts, defaultTenantId = '2sg' }) {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const account = getAccounts().find(candidate => candidate && candidate.active !== false
      && (candidate.id || candidate.userId || candidate.email) === req.user?.id
      && (candidate.tenantId || candidate.organizationId || defaultTenantId) === req.user?.tenantId);
    if (!account) return res.status(401).json({ success: false, code: 'BUDGET_UNAUTHENTICATED' });
    // Re-read Finance rights from the current account, not just the possibly older signed token.
    req.user = { ...req.user, permissions: permissionsForAccount(account), financePermissionsExplicit: true };
    return next();
  };
}

function createBudgetDraftHandlers({ bigquery, projectId, datasetId, location = 'US', enabled = false,
  idGenerator = () => crypto.randomUUID(), logger = console }) {
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
    respond(res, 503, 'BUDGET_STORAGE_DISABLED'); return false;
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
        personalEnabled: false, canWrite: enabled === true && permissionsForUser(req.user).includes(PERMISSIONS.WRITE) });
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

module.exports = { validateBudget, buildBudgetSchemaStatements, budgetDraftsEnabled, createBudgetBodyMiddleware, createBudgetAccountMiddleware, createBudgetDraftHandlers };

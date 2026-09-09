const {
  CURRENT_TABLE,
  EVENT_TABLE,
  SCHEMA_NAME
} = require('./financeBudgetV2PostgresSchema');
const { TARGET } = require('./financeBudgetV2StorageAdapter');

const CONTRACT_ID = 'BUDGET-T1-D-B-3-A-001';
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_LIMIT = 50;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_PATTERN = /^[\x20-\x7e]{1,128}$/;
const TARGET_KEYS = Object.freeze(Object.keys(TARGET));
const ROW_KEYS = Object.freeze([
  'id', 'tenant_id', 'author_user_id', 'contract_version', 'version', 'title',
  'entity', 'year', 'scope', 'status', 'access', 'document_json', 'document_bytes',
  'created_at', 'updated_at'
]);
const AUDIT_KEYS = Object.freeze([
  'action', 'draft_id', 'tenant_id', 'actor_user_id', 'version', 'occurred_at'
]);
const CURRENT_COLUMNS = `id, tenant_id, author_user_id, contract_version, version,
  title, entity, year, scope, status, access, document_json, document_bytes,
  created_at, updated_at`;
const CURRENT = `"${SCHEMA_NAME}"."${CURRENT_TABLE}"`;
const EVENTS = `"${SCHEMA_NAME}"."${EVENT_TABLE}"`;

class BudgetV2PostgresStorageExecutorError extends Error {
  constructor() {
    super('Budget V2 PostgreSQL storage executor failed');
    this.name = 'BudgetV2PostgresStorageExecutorError';
    this.code = 'BUDGET_V2_POSTGRES_STORAGE_UNAVAILABLE';
  }
}

const fail = () => { throw new BudgetV2PostgresStorageExecutorError(); };

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function reference(value) {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value)
    && Boolean(value.trim());
}

function instant(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail();
}

function validateQuerySession(session) {
  if (!session || typeof session !== 'object'
    || typeof session.query !== 'function'
    || !exact(session.capabilities, ['environment', 'engine', 'networkMode', 'storageMode'])
    || session.capabilities.environment !== 'local-ephemeral'
    || session.capabilities.engine !== 'pglite-postgresql'
    || session.capabilities.networkMode !== 'none'
    || session.capabilities.storageMode !== 'memory-only') fail();
}

function validateSession(session) {
  validateQuerySession(session);
  if (typeof session.transaction !== 'function') fail();
}

function validateTarget(target) {
  if (!exact(target, TARGET_KEYS)
    || TARGET_KEYS.some(key => target[key] !== TARGET[key])) fail();
}

function validateRequest(request, operation, keys) {
  if (!exact(request, ['operation', 'target', ...keys])
    || request.operation !== operation) fail();
  validateTarget(request.target);
}

function validateScope(where, keys) {
  if (!exact(where, keys)
    || !reference(where.tenantId)
    || !reference(where.authorUserId)
    || where.contractVersion !== 2) fail();
}

function validateRow(row) {
  if (!exact(row, ROW_KEYS)
    || typeof row.id !== 'string' || !ID_PATTERN.test(row.id)
    || !reference(row.tenant_id) || !reference(row.author_user_id)
    || row.contract_version !== 2
    || !Number.isInteger(row.version) || row.version < 1 || row.version > 1000000
    || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 120
    || typeof row.entity !== 'string' || !row.entity.trim() || row.entity.length > 200
    || typeof row.year !== 'string' || !/^\d{4}$/.test(row.year)
    || row.scope !== 'organization' || row.status !== 'draft'
    || row.access !== 'owner-only'
    || typeof row.document_json !== 'string'
    || !Number.isInteger(row.document_bytes) || row.document_bytes < 1
    || row.document_bytes > MAX_DOCUMENT_BYTES
    || Buffer.byteLength(row.document_json, 'utf8') !== row.document_bytes) fail();
  try {
    JSON.parse(row.document_json);
  } catch (_error) {
    fail();
  }
  instant(row.created_at);
  instant(row.updated_at);
  if (row.created_at > row.updated_at) fail();
}

function validateAudit(audit, row) {
  if (!exact(audit, AUDIT_KEYS)
    || !['budget_v2_draft_created', 'budget_v2_draft_updated'].includes(audit.action)
    || audit.draft_id !== row.id
    || audit.tenant_id !== row.tenant_id
    || audit.actor_user_id !== row.author_user_id
    || audit.version !== row.version
    || audit.occurred_at !== row.updated_at) fail();
}

function timestamp(value) {
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return new Date(value).toISOString();
  } catch (_error) {
    fail();
  }
  fail();
}

function normalizeRow(row) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    author_user_id: row.author_user_id,
    contract_version: Number(row.contract_version),
    version: Number(row.version),
    title: row.title,
    entity: row.entity,
    year: row.year,
    scope: row.scope,
    status: row.status,
    access: row.access,
    document_json: row.document_json,
    document_bytes: Number(row.document_bytes),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function rowValues(row) {
  return [
    row.tenant_id, row.author_user_id, row.id, row.contract_version, row.version,
    row.title, row.entity, row.year, row.scope, row.status, row.access,
    row.document_json, row.document_bytes, row.created_at, row.updated_at
  ];
}

function auditValues(audit) {
  return [
    audit.tenant_id, audit.actor_user_id, audit.draft_id,
    audit.version, audit.action, audit.occurred_at
  ];
}

function isUniqueViolation(error) {
  return error?.code === '23505' || error?.cause?.code === '23505';
}

const INSERT_CURRENT = `INSERT INTO ${CURRENT} (
  tenant_id, author_user_id, id, contract_version, version, title, entity,
  year, scope, status, access, document_json, document_bytes, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;

const INSERT_AUDIT = `INSERT INTO ${EVENTS} (
  tenant_id, actor_user_id, draft_id, version, action, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6)`;

const UPDATE_CURRENT = `UPDATE ${CURRENT} SET
  version = $6, title = $7, entity = $8, year = $9, scope = $10,
  status = $11, access = $12, document_json = $13, document_bytes = $14,
  updated_at = $15
WHERE tenant_id = $1 AND author_user_id = $2 AND id = $3
  AND contract_version = $4 AND version = $5
RETURNING id, version`;

function createBudgetV2PostgresStorageExecutor({ session } = {}) {
  validateSession(session);

  async function read(query, params) {
    try {
      const result = await session.query(query, params);
      if (!result || !Array.isArray(result.rows)) fail();
      return result.rows;
    } catch (error) {
      if (error instanceof BudgetV2PostgresStorageExecutorError) throw error;
      fail();
    }
  }

  async function probe(request) {
    validateRequest(request, 'probe', []);
    const rows = await read(`SELECT
      to_regclass($1) IS NOT NULL AS current_exists,
      to_regclass($2) IS NOT NULL AS events_exists`, [
      `${SCHEMA_NAME}.${CURRENT_TABLE}`, `${SCHEMA_NAME}.${EVENT_TABLE}`
    ]);
    if (rows.length !== 1 || rows[0].current_exists !== true
      || rows[0].events_exists !== true) fail();
    return {
      available: true,
      contract: {
        ...TARGET,
        effectiveUniqueness: true,
        atomicCreate: true,
        atomicReplace: true
      }
    };
  }

  async function getCurrent(request) {
    validateRequest(request, 'getCurrent', ['where', 'limit']);
    validateScope(request.where, ['id', 'tenantId', 'authorUserId', 'contractVersion']);
    if (!ID_PATTERN.test(request.where.id) || request.limit !== 2) fail();
    const rows = await read(`SELECT ${CURRENT_COLUMNS} FROM ${CURRENT}
      WHERE tenant_id = $1 AND author_user_id = $2 AND id = $3
        AND contract_version = $4 LIMIT $5`, [
      request.where.tenantId, request.where.authorUserId, request.where.id,
      request.where.contractVersion, request.limit
    ]);
    return { available: true, rows: rows.map(normalizeRow) };
  }

  async function scanCurrent(request) {
    validateRequest(request, 'scanCurrent', ['where', 'order', 'after', 'limit']);
    validateScope(request.where, ['tenantId', 'authorUserId', 'contractVersion']);
    if (!Array.isArray(request.order)
      || request.order.length !== 2
      || request.order[0] !== 'updatedAt:desc' || request.order[1] !== 'id:asc'
      || !Number.isInteger(request.limit) || request.limit < 1
      || request.limit > MAX_SCAN_LIMIT) fail();
    if (request.after !== null) {
      if (!exact(request.after, ['updatedAt', 'id'])
        || !ID_PATTERN.test(request.after.id)) fail();
      instant(request.after.updatedAt);
    }
    const params = [
      request.where.tenantId, request.where.authorUserId,
      request.where.contractVersion
    ];
    let cursor = '';
    if (request.after) {
      cursor = `AND (updated_at < $4 OR (updated_at = $4 AND id > $5))`;
      params.push(request.after.updatedAt, request.after.id);
    }
    params.push(request.limit);
    const limitIndex = params.length;
    const rows = await read(`SELECT id, updated_at, document_bytes FROM ${CURRENT}
      WHERE tenant_id = $1 AND author_user_id = $2 AND contract_version = $3
      ${cursor}
      ORDER BY updated_at DESC, id ASC LIMIT $${limitIndex}`, params);
    const normalized = rows.map(row => ({
      id: row.id,
      updated_at: timestamp(row.updated_at),
      document_bytes: Number(row.document_bytes)
    }));
    const last = normalized.at(-1);
    return {
      available: true,
      rows: normalized,
      nextCursor: normalized.length === request.limit
        ? { updatedAt: last.updated_at, id: last.id }
        : null
    };
  }

  async function loadCurrent(request) {
    validateRequest(request, 'loadCurrent', ['where', 'limit']);
    validateScope(request.where, [
      'id', 'tenantId', 'authorUserId', 'contractVersion', 'updatedAt'
    ]);
    if (!ID_PATTERN.test(request.where.id) || request.limit !== 2) fail();
    instant(request.where.updatedAt);
    const rows = await read(`SELECT ${CURRENT_COLUMNS} FROM ${CURRENT}
      WHERE tenant_id = $1 AND author_user_id = $2 AND id = $3
        AND contract_version = $4 AND updated_at = $5 LIMIT $6`, [
      request.where.tenantId, request.where.authorUserId, request.where.id,
      request.where.contractVersion, request.where.updatedAt, request.limit
    ]);
    return { available: true, rows: rows.map(normalizeRow) };
  }

  async function findPromotionLinks(request) {
    validateRequest(request, 'findPromotionLinks', ['where']);
    validateScope(request.where, [
      'draftId', 'tenantId', 'authorUserId', 'contractVersion'
    ]);
    if (!ID_PATTERN.test(request.where.draftId)) fail();
    return { available: true, rows: [] };
  }

  async function createAtomic(request) {
    validateRequest(request, 'createAtomic', ['row', 'audit']);
    validateRow(request.row);
    validateAudit(request.audit, request.row);
    if (request.row.version !== 1
      || request.row.created_at !== request.row.updated_at
      || request.audit.action !== 'budget_v2_draft_created') fail();
    let stage = 'before-transaction';
    try {
      await session.transaction(async transaction => {
        validateQuerySession(transaction);
        stage = 'transaction-open';
        await transaction.query(INSERT_CURRENT, rowValues(request.row));
        stage = 'current-inserted';
        await transaction.query(INSERT_AUDIT, auditValues(request.audit));
        stage = 'ready-to-commit';
      });
      return { outcome: 'created', id: request.row.id, version: 1 };
    } catch (error) {
      if (stage === 'ready-to-commit') return { outcome: 'uncertain' };
      if (isUniqueViolation(error)) return { outcome: 'duplicate' };
      return { outcome: 'unavailable' };
    }
  }

  async function replaceAtomic(request) {
    validateRequest(request, 'replaceAtomic', ['where', 'row', 'audit']);
    validateScope(request.where, [
      'id', 'tenantId', 'authorUserId', 'contractVersion', 'expectedVersion'
    ]);
    if (!ID_PATTERN.test(request.where.id)
      || !Number.isInteger(request.where.expectedVersion)
      || request.where.expectedVersion < 1) fail();
    validateRow(request.row);
    validateAudit(request.audit, request.row);
    if (request.row.id !== request.where.id
      || request.row.tenant_id !== request.where.tenantId
      || request.row.author_user_id !== request.where.authorUserId
      || request.row.version !== request.where.expectedVersion + 1
      || request.audit.action !== 'budget_v2_draft_updated') fail();
    let stage = 'before-transaction';
    let classified = null;
    try {
      await session.transaction(async transaction => {
        validateQuerySession(transaction);
        stage = 'transaction-open';
        const updated = await transaction.query(UPDATE_CURRENT, [
          request.where.tenantId, request.where.authorUserId, request.where.id,
          request.where.contractVersion, request.where.expectedVersion,
          request.row.version, request.row.title, request.row.entity, request.row.year,
          request.row.scope, request.row.status, request.row.access,
          request.row.document_json, request.row.document_bytes, request.row.updated_at
        ]);
        if (!updated || !Array.isArray(updated.rows) || updated.rows.length > 1) fail();
        if (updated.rows.length === 0) {
          const existing = await transaction.query(`SELECT version FROM ${CURRENT}
            WHERE tenant_id = $1 AND author_user_id = $2 AND id = $3
              AND contract_version = $4 LIMIT 2`, [
            request.where.tenantId, request.where.authorUserId,
            request.where.id, request.where.contractVersion
          ]);
          if (!existing || !Array.isArray(existing.rows) || existing.rows.length > 1) fail();
          classified = existing.rows.length === 0 ? 'missing' : 'conflict';
          return;
        }
        stage = 'current-updated';
        await transaction.query(INSERT_AUDIT, auditValues(request.audit));
        stage = 'ready-to-commit';
      });
      if (classified) return { outcome: classified };
      return { outcome: 'updated', id: request.row.id, version: request.row.version };
    } catch (error) {
      if (stage === 'ready-to-commit') return { outcome: 'uncertain' };
      if (isUniqueViolation(error)) return { outcome: 'duplicate' };
      return { outcome: 'unavailable' };
    }
  }

  return Object.freeze({
    probe,
    getCurrent,
    scanCurrent,
    loadCurrent,
    findPromotionLinks,
    createAtomic,
    replaceAtomic
  });
}

module.exports = {
  BudgetV2PostgresStorageExecutorError,
  CONTRACT_ID,
  createBudgetV2PostgresStorageExecutor
};

const crypto = require('node:crypto');
const {
  CURRENT_TABLE,
  EVENT_TABLE,
  LIST_INDEX,
  MAX_POSTGRES_MAJOR,
  MIN_POSTGRES_MAJOR,
  SCHEMA_NAME,
  buildBudgetV2PostgresOfflinePlan
} = require('./financeBudgetV2PostgresSchema');
const {
  COLLECTOR_CONTRACT,
  DATABASE_NAME,
  validateBudgetV2PostgresMigrationAuthorization
} = require('./financeBudgetV2PostgresMigrationPlanner');

const CONTRACT_ID = 'BUDGET-T1-D-B-2-C-001';
const MAX_EXECUTION_MS = 2 * 60 * 1000;
const EXECUTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{4,95}$/;
const CONTEXT_KEYS = Object.freeze([
  'executionRef', 'targetRef', 'environment', 'engine',
  'dataClassification', 'startedAt', 'deadlineAt', 'networkMode',
  'storageMode'
]);
const SESSION_CAPABILITY_KEYS = Object.freeze([
  'environment', 'engine', 'networkMode', 'storageMode'
]);
const TARGET_KEYS = Object.freeze([
  'targetRef', 'environment', 'engine', 'postgresMajor', 'databaseName',
  'schemaName', 'databaseEncoding', 'dataClassification'
]);

const EXPECTED_CONSTRAINTS = Object.freeze({
  [CURRENT_TABLE]: Object.freeze({
    ck_budget_v2_current_access: Object.freeze(['c', "CHECK (access::text = 'owner-only'::text)"]),
    ck_budget_v2_current_author: Object.freeze(['c', "CHECK (btrim(author_user_id::text) <> ''::text AND author_user_id::text !~ '[^ -~]'::text)"]),
    ck_budget_v2_current_contract: Object.freeze(['c', 'CHECK (contract_version = 2)']),
    ck_budget_v2_current_document_bytes: Object.freeze(['c', 'CHECK (document_bytes >= 1 AND document_bytes <= 4194304 AND octet_length(document_json) = document_bytes)']),
    ck_budget_v2_current_entity: Object.freeze(['c', "CHECK (btrim(entity::text) <> ''::text)"]),
    ck_budget_v2_current_scope: Object.freeze(['c', "CHECK (scope::text = 'organization'::text)"]),
    ck_budget_v2_current_status: Object.freeze(['c', "CHECK (status::text = 'draft'::text)"]),
    ck_budget_v2_current_tenant: Object.freeze(['c', "CHECK (btrim(tenant_id::text) <> ''::text AND tenant_id::text !~ '[^ -~]'::text)"]),
    ck_budget_v2_current_timeline: Object.freeze(['c', 'CHECK (created_at <= updated_at)']),
    ck_budget_v2_current_title: Object.freeze(['c', "CHECK (btrim(title::text) <> ''::text)"]),
    ck_budget_v2_current_version: Object.freeze(['c', 'CHECK (version >= 1 AND version <= 1000000)']),
    ck_budget_v2_current_year: Object.freeze(['c', "CHECK (year ~ '^[0-9]{4}$'::text)"]),
    pk_budget_v2_current: Object.freeze(['p', 'PRIMARY KEY (tenant_id, author_user_id, id)'])
  }),
  [EVENT_TABLE]: Object.freeze({
    ck_budget_v2_events_action: Object.freeze(['c', "CHECK (action::text = ANY (ARRAY['budget_v2_draft_created'::character varying, 'budget_v2_draft_updated'::character varying]::text[]))"]),
    ck_budget_v2_events_actor: Object.freeze(['c', "CHECK (btrim(actor_user_id::text) <> ''::text AND actor_user_id::text !~ '[^ -~]'::text)"]),
    ck_budget_v2_events_tenant: Object.freeze(['c', "CHECK (btrim(tenant_id::text) <> ''::text AND tenant_id::text !~ '[^ -~]'::text)"]),
    ck_budget_v2_events_version: Object.freeze(['c', 'CHECK (version >= 1 AND version <= 1000000)']),
    fk_budget_v2_events_current: Object.freeze(['f', `FOREIGN KEY (tenant_id, actor_user_id, draft_id) REFERENCES ${SCHEMA_NAME}.${CURRENT_TABLE}(tenant_id, author_user_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT`]),
    pk_budget_v2_events: Object.freeze(['p', 'PRIMARY KEY (event_id)']),
    uq_budget_v2_events_mutation: Object.freeze(['u', 'UNIQUE (tenant_id, actor_user_id, draft_id, version, action)'])
  })
});

const EXPECTED_INDEXES = Object.freeze({
  [CURRENT_TABLE]: Object.freeze({
    [LIST_INDEX]: Object.freeze([false, `CREATE INDEX ${LIST_INDEX} ON ${SCHEMA_NAME}.${CURRENT_TABLE} USING btree (tenant_id, author_user_id, updated_at DESC, id)`]),
    pk_budget_v2_current: Object.freeze([true, `CREATE UNIQUE INDEX pk_budget_v2_current ON ${SCHEMA_NAME}.${CURRENT_TABLE} USING btree (tenant_id, author_user_id, id)`])
  }),
  [EVENT_TABLE]: Object.freeze({
    pk_budget_v2_events: Object.freeze([true, `CREATE UNIQUE INDEX pk_budget_v2_events ON ${SCHEMA_NAME}.${EVENT_TABLE} USING btree (event_id)`]),
    uq_budget_v2_events_mutation: Object.freeze([true, `CREATE UNIQUE INDEX uq_budget_v2_events_mutation ON ${SCHEMA_NAME}.${EVENT_TABLE} USING btree (tenant_id, actor_user_id, draft_id, version, action)`])
  })
});

class BudgetV2PostgresEphemeralExecutorError extends Error {
  constructor() {
    super('Invalid Budget V2 PostgreSQL ephemeral execution');
    this.name = 'BudgetV2PostgresEphemeralExecutorError';
    this.code = 'BUDGET_V2_POSTGRES_EPHEMERAL_EXECUTION_INVALID';
  }
}

const fail = () => { throw new BudgetV2PostgresEphemeralExecutorError(); };

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch (_error) {
    fail();
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function instant(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail();
  return parsed.getTime();
}

function validateCapabilities(capabilities) {
  if (!exact(capabilities, SESSION_CAPABILITY_KEYS)
    || capabilities.environment !== 'local-ephemeral'
    || capabilities.engine !== 'pglite-postgresql'
    || capabilities.networkMode !== 'none'
    || capabilities.storageMode !== 'memory-only') fail();
}

function validateQuerySession(session) {
  if (!session || typeof session !== 'object'
    || typeof session.query !== 'function') fail();
  validateCapabilities(session.capabilities);
}

function validateExecutionSession(session) {
  validateQuerySession(session);
  if (typeof session.transaction !== 'function') fail();
}

function createBudgetV2PGliteEphemeralSession(database) {
  if (!database || typeof database.query !== 'function'
    || typeof database.exec !== 'function'
    || typeof database.transaction !== 'function') fail();
  const capabilities = deepFreeze({
    environment: 'local-ephemeral',
    engine: 'pglite-postgresql',
    networkMode: 'none',
    storageMode: 'memory-only'
  });
  const wrapTransaction = transaction => deepFreeze({
    capabilities,
    query: (text, params) => transaction.query(text, params),
    exec: text => transaction.exec(text)
  });
  return deepFreeze({
    capabilities,
    query: (text, params) => database.query(text, params),
    transaction: callback => database.transaction(
      transaction => callback(wrapTransaction(transaction))
    )
  });
}

function typeName(column) {
  const names = {
    varchar: 'character varying',
    char: 'character',
    timestamptz: 'timestamp with time zone'
  };
  return names[column.type] || column.type;
}

function expectedColumns(schemaPlan) {
  return schemaPlan.expectedCatalog.tables.flatMap(table => table.columns.map(
    (column, index) => ({
      table_name: table.name,
      column_name: column.name,
      data_type: typeName(column),
      character_maximum_length: column.length || null,
      is_nullable: column.nullable ? 'YES' : 'NO',
      is_identity: column.identity ? 'YES' : 'NO',
      identity_generation: column.identity ? column.identity.toUpperCase() : null,
      ordinal_position: index + 1
    })
  )).sort((left, right) => left.table_name.localeCompare(right.table_name)
    || left.ordinal_position - right.ordinal_position);
}

function expectedConstraintRows() {
  return Object.entries(EXPECTED_CONSTRAINTS).flatMap(([tableName, constraints]) => (
    Object.entries(constraints).map(([name, [type, definition]]) => ({
      table_name: tableName,
      conname: name,
      contype: type,
      definition
    }))
  )).sort((left, right) => left.table_name.localeCompare(right.table_name)
    || left.conname.localeCompare(right.conname));
}

function expectedIndexRows() {
  return Object.entries(EXPECTED_INDEXES).flatMap(([tableName, indexes]) => (
    Object.entries(indexes).map(([name, [unique, definition]]) => ({
      table_name: tableName,
      index_name: name,
      indisunique: unique,
      definition
    }))
  )).sort((left, right) => left.table_name.localeCompare(right.table_name)
    || left.index_name.localeCompare(right.index_name));
}

const METADATA_QUERIES = Object.freeze({
  schema: `SELECT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = $1
  ) AS exists`,
  relations: `SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
    ORDER BY c.relkind, c.relname`,
  columns: `SELECT table_name, column_name, data_type,
      character_maximum_length, is_nullable, is_identity,
      identity_generation, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = $1
    ORDER BY table_name, ordinal_position`,
  constraints: `SELECT t.relname AS table_name, c.conname, c.contype,
      pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1 AND c.contype <> 'n'
    ORDER BY t.relname, c.conname`,
  indexes: `SELECT t.relname AS table_name, i.relname AS index_name,
      ix.indisunique, pg_get_indexdef(ix.indexrelid) AS definition
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1
    ORDER BY t.relname, i.relname`,
  triggers: `SELECT t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal
    ORDER BY t.tgname`,
  routines: `SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1
    ORDER BY p.proname`,
  extensions: `SELECT e.extname
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE n.nspname = $1
    ORDER BY e.extname`,
  grants: `SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = $1 AND grantee <> current_user
    ORDER BY table_name, grantee, privilege_type`
});

function exactRows(actual, expected) {
  return canonical(actual) === canonical(expected);
}

function expectedRelations() {
  return [
    { relname: `${EVENT_TABLE}_event_id_seq`, relkind: 'S' },
    { relname: LIST_INDEX, relkind: 'i' },
    { relname: 'pk_budget_v2_current', relkind: 'i' },
    { relname: 'pk_budget_v2_events', relkind: 'i' },
    { relname: 'uq_budget_v2_events_mutation', relkind: 'i' },
    { relname: EVENT_TABLE, relkind: 'r' },
    { relname: CURRENT_TABLE, relkind: 'r' }
  ];
}

async function collectInventory({
  session, target, observedAt
} = {}) {
  validateQuerySession(session);
  instant(observedAt);
  if (!exact(target, TARGET_KEYS)
    || !EXECUTION_REF_PATTERN.test(target.targetRef)
    || target.schemaName !== SCHEMA_NAME
    || target.environment !== 'local-ephemeral'
    || target.engine !== 'postgresql'
    || !Number.isInteger(target.postgresMajor)
    || target.postgresMajor < MIN_POSTGRES_MAJOR
    || target.postgresMajor > MAX_POSTGRES_MAJOR
    || target.databaseName !== DATABASE_NAME
    || target.databaseEncoding !== 'UTF8'
    || target.dataClassification !== 'synthetic-only') fail();

  const versionResult = await session.query('SHOW server_version');
  const encodingResult = await session.query('SHOW server_encoding');
  const postgresMajor = Number.parseInt(versionResult?.rows?.[0]?.server_version, 10);
  const databaseEncoding = encodingResult?.rows?.[0]?.server_encoding;
  if (!Number.isInteger(postgresMajor)
    || postgresMajor < MIN_POSTGRES_MAJOR || postgresMajor > MAX_POSTGRES_MAJOR
    || databaseEncoding !== 'UTF8' || postgresMajor !== target.postgresMajor) fail();

  const schemaResult = await session.query(METADATA_QUERIES.schema, [SCHEMA_NAME]);
  if (schemaResult?.rows?.[0]?.exists !== true) {
    return deepFreeze({
      targetRef: target.targetRef,
      observedAt,
      collectorContract: COLLECTOR_CONTRACT,
      databaseEncoding,
      postgresMajor,
      schemaState: 'missing',
      catalog: null,
      catalogFingerprint: null,
      unexpectedObjects: []
    });
  }

  const entries = await Promise.all(Object.entries(METADATA_QUERIES)
    .filter(([name]) => name !== 'schema')
    .map(async ([name, query]) => [name, (await session.query(query, [SCHEMA_NAME])).rows]));
  const metadata = Object.fromEntries(entries);
  const objectCount = metadata.relations.length + metadata.triggers.length
    + metadata.routines.length + metadata.extensions.length + metadata.grants.length;
  if (objectCount === 0) {
    return deepFreeze({
      targetRef: target.targetRef,
      observedAt,
      collectorContract: COLLECTOR_CONTRACT,
      databaseEncoding,
      postgresMajor,
      schemaState: 'empty',
      catalog: null,
      catalogFingerprint: null,
      unexpectedObjects: []
    });
  }

  const schemaPlan = buildBudgetV2PostgresOfflinePlan();
  const conformant = exactRows(metadata.relations, expectedRelations())
    && exactRows(metadata.columns, expectedColumns(schemaPlan))
    && exactRows(metadata.constraints, expectedConstraintRows())
    && exactRows(metadata.indexes, expectedIndexRows())
    && metadata.triggers.length === 0 && metadata.routines.length === 0
    && metadata.extensions.length === 0 && metadata.grants.length === 0;
  if (!conformant) {
    return deepFreeze({
      targetRef: target.targetRef,
      observedAt,
      collectorContract: COLLECTOR_CONTRACT,
      databaseEncoding,
      postgresMajor,
      schemaState: 'divergent',
      catalog: null,
      catalogFingerprint: null,
      unexpectedObjects: ['catalog-drift']
    });
  }
  const catalog = clone(schemaPlan.expectedCatalog);
  return deepFreeze({
    targetRef: target.targetRef,
    observedAt,
    collectorContract: COLLECTOR_CONTRACT,
    databaseEncoding,
    postgresMajor,
    schemaState: 'conformant',
    catalog,
    catalogFingerprint: fingerprint(catalog),
    unexpectedObjects: []
  });
}

async function collectBudgetV2PostgresInventory(input) {
  try {
    return await collectInventory(input);
  } catch (error) {
    if (error instanceof BudgetV2PostgresEphemeralExecutorError) throw error;
    fail();
  }
}

function createBudgetV2EphemeralConsumptionStore() {
  const states = new Map();
  return Object.freeze({
    reserve(planFingerprint) {
      if (!/^[0-9a-f]{64}$/.test(planFingerprint || '')
        || states.has(planFingerprint)) return false;
      states.set(planFingerprint, 'reserved');
      return true;
    },
    finalize(planFingerprint, state) {
      if (states.get(planFingerprint) !== 'reserved'
        || !['applied', 'failed', 'uncertain'].includes(state)) fail();
      states.set(planFingerprint, state);
      return state;
    },
    getState(planFingerprint) {
      return states.get(planFingerprint) || null;
    }
  });
}

function validateExecutionContext(context, plan) {
  if (!plan || typeof plan !== 'object' || !plan.target
    || !exact(context, CONTEXT_KEYS)
    || !EXECUTION_REF_PATTERN.test(context.executionRef)
    || context.targetRef !== plan.target.targetRef
    || context.environment !== 'local-ephemeral'
    || context.engine !== 'pglite-postgresql'
    || context.dataClassification !== 'synthetic-only'
    || context.networkMode !== 'none' || context.storageMode !== 'memory-only') fail();
  const startedAt = instant(context.startedAt);
  const deadlineAt = instant(context.deadlineAt);
  if (deadlineAt < startedAt || deadlineAt - startedAt > MAX_EXECUTION_MS) fail();
  return { startedAt, deadlineAt };
}

function validateTransactionSession(transaction) {
  validateQuerySession(transaction);
  if (typeof transaction.exec !== 'function') fail();
}

function proof({ context, plan, executedStatements, afterInventory, outcome, state }) {
  return deepFreeze({
    contractId: CONTRACT_ID,
    executionRef: context.executionRef,
    planFingerprint: plan.fingerprint,
    targetRef: plan.target.targetRef,
    postgresMajor: plan.target.postgresMajor,
    startedAt: context.startedAt,
    finishedAt: context.deadlineAt,
    expectedStatements: plan.statements.length,
    appliedStatements: outcome === 'applied'
      ? executedStatements : (outcome === 'failed' ? 0 : null),
    beforeInventoryFingerprint: plan.inventoryFingerprint,
    afterInventoryFingerprint: afterInventory ? fingerprint(afterInventory) : null,
    catalogValid: afterInventory?.schemaState === 'conformant',
    consumptionState: state,
    outcome
  });
}

async function executeBudgetV2PostgresEphemeralMigration({
  session, plan, authorization, executionContext, consumptionStore,
  inspectCatalog = collectBudgetV2PostgresInventory
} = {}) {
  validateExecutionSession(session);
  const times = validateExecutionContext(executionContext, plan);
  if (!consumptionStore || typeof consumptionStore.reserve !== 'function'
    || typeof consumptionStore.finalize !== 'function'
    || typeof consumptionStore.getState !== 'function'
    || typeof inspectCatalog !== 'function') fail();
  try {
    validateBudgetV2PostgresMigrationAuthorization({
      plan, authorization, now: executionContext.startedAt
    });
  } catch (_error) {
    fail();
  }
  if (times.startedAt > times.deadlineAt
    || !consumptionStore.reserve(plan.fingerprint)) fail();

  let stage = 'reserved';
  let executedStatements = 0;
  let afterInventory = null;
  try {
    await session.transaction(async transaction => {
      validateTransactionSession(transaction);
      stage = 'transaction-open';
      for (const statement of plan.statements) {
        await transaction.exec(statement);
        executedStatements += 1;
      }
      stage = 'catalog-check';
      const insideInventory = await inspectCatalog({
        session: transaction,
        target: plan.target,
        observedAt: executionContext.deadlineAt
      });
      if (insideInventory.schemaState !== 'conformant') fail();
      stage = 'ready-to-commit';
    });
    stage = 'committed';
    afterInventory = await inspectCatalog({
      session,
      target: plan.target,
      observedAt: executionContext.deadlineAt
    });
    if (afterInventory.schemaState !== 'conformant') fail();
    consumptionStore.finalize(plan.fingerprint, 'applied');
    return proof({
      context: executionContext,
      plan,
      executedStatements,
      afterInventory,
      outcome: 'applied',
      state: 'applied'
    });
  } catch (_error) {
    let state = stage === 'ready-to-commit' || stage === 'committed'
      ? 'uncertain' : 'failed';
    try {
      consumptionStore.finalize(plan.fingerprint, state);
    } catch (_finalizeError) {
      state = 'uncertain';
    }
    return proof({
      context: executionContext,
      plan,
      executedStatements,
      afterInventory: null,
      outcome: state,
      state
    });
  }
}

module.exports = {
  BudgetV2PostgresEphemeralExecutorError,
  CONTRACT_ID,
  MAX_EXECUTION_MS,
  collectBudgetV2PostgresInventory,
  createBudgetV2EphemeralConsumptionStore,
  createBudgetV2PGliteEphemeralSession,
  executeBudgetV2PostgresEphemeralMigration
};

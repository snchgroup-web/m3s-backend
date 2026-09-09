const crypto = require('node:crypto');

const CONTRACT_ID = 'BUDGET-T1-D-B-2-A-001';
const PLAN_VERSION = 1;
const SCHEMA_NAME = 'finance_budget_v2';
const CURRENT_TABLE = 'finance_budget_drafts_v2_current';
const EVENT_TABLE = 'finance_budget_draft_events_v2';
const LIST_INDEX = 'ix_budget_v2_current_owner_updated_id';
const MIN_POSTGRES_MAJOR = 16;
const MAX_POSTGRES_MAJOR = 18;

class BudgetV2PostgresSchemaError extends Error {
  constructor() {
    super('Invalid Budget V2 PostgreSQL schema plan');
    this.name = 'BudgetV2PostgresSchemaError';
    this.code = 'BUDGET_V2_POSTGRES_SCHEMA_INVALID';
  }
}

const fail = () => { throw new BudgetV2PostgresSchemaError(); };

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
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

function quoted(identifier) {
  return `"${identifier}"`;
}

function qualified(schemaName, tableName) {
  return `${quoted(schemaName)}.${quoted(tableName)}`;
}

const column = (name, type, options = {}) => ({
  name,
  type,
  nullable: false,
  identity: null,
  ...options
});

function expectedCatalog(schemaName) {
  return {
    engine: 'postgresql',
    schemaName,
    databaseEncoding: 'UTF8',
    tables: [
      {
        name: CURRENT_TABLE,
        columns: [
          column('tenant_id', 'varchar', { length: 128 }),
          column('author_user_id', 'varchar', { length: 128 }),
          column('id', 'uuid'),
          column('contract_version', 'smallint'),
          column('version', 'integer'),
          column('title', 'varchar', { length: 120 }),
          column('entity', 'varchar', { length: 200 }),
          column('year', 'char', { length: 4 }),
          column('scope', 'varchar', { length: 12 }),
          column('status', 'varchar', { length: 5 }),
          column('access', 'varchar', { length: 16 }),
          column('document_json', 'text'),
          column('document_bytes', 'integer'),
          column('created_at', 'timestamptz'),
          column('updated_at', 'timestamptz')
        ],
        primaryKey: {
          name: 'pk_budget_v2_current',
          columns: ['tenant_id', 'author_user_id', 'id']
        },
        uniqueConstraints: [],
        checks: [
          { name: 'ck_budget_v2_current_tenant', rule: 'visible-ascii-nonempty-tenant' },
          { name: 'ck_budget_v2_current_author', rule: 'visible-ascii-nonempty-author' },
          { name: 'ck_budget_v2_current_contract', rule: 'contract-version-2' },
          { name: 'ck_budget_v2_current_version', rule: 'version-1-to-1000000' },
          { name: 'ck_budget_v2_current_title', rule: 'nonempty-title' },
          { name: 'ck_budget_v2_current_entity', rule: 'nonempty-entity' },
          { name: 'ck_budget_v2_current_year', rule: 'four-digit-year' },
          { name: 'ck_budget_v2_current_scope', rule: 'scope-organization' },
          { name: 'ck_budget_v2_current_status', rule: 'status-draft' },
          { name: 'ck_budget_v2_current_access', rule: 'access-owner-only' },
          { name: 'ck_budget_v2_current_document_bytes', rule: 'utf8-bytes-1-to-4194304' },
          { name: 'ck_budget_v2_current_timeline', rule: 'created-before-or-at-updated' }
        ],
        foreignKeys: [],
        indexes: [
          {
            name: LIST_INDEX,
            unique: false,
            columns: [
              { name: 'tenant_id', direction: 'asc' },
              { name: 'author_user_id', direction: 'asc' },
              { name: 'updated_at', direction: 'desc' },
              { name: 'id', direction: 'asc' }
            ]
          }
        ]
      },
      {
        name: EVENT_TABLE,
        columns: [
          column('event_id', 'bigint', { identity: 'always' }),
          column('tenant_id', 'varchar', { length: 128 }),
          column('actor_user_id', 'varchar', { length: 128 }),
          column('draft_id', 'uuid'),
          column('version', 'integer'),
          column('action', 'varchar', { length: 32 }),
          column('occurred_at', 'timestamptz')
        ],
        primaryKey: { name: 'pk_budget_v2_events', columns: ['event_id'] },
        uniqueConstraints: [
          {
            name: 'uq_budget_v2_events_mutation',
            columns: ['tenant_id', 'actor_user_id', 'draft_id', 'version', 'action']
          }
        ],
        checks: [
          { name: 'ck_budget_v2_events_tenant', rule: 'visible-ascii-nonempty-tenant' },
          { name: 'ck_budget_v2_events_actor', rule: 'visible-ascii-nonempty-actor' },
          { name: 'ck_budget_v2_events_version', rule: 'version-1-to-1000000' },
          { name: 'ck_budget_v2_events_action', rule: 'created-or-updated-action' }
        ],
        foreignKeys: [
          {
            name: 'fk_budget_v2_events_current',
            columns: ['tenant_id', 'actor_user_id', 'draft_id'],
            referencedTable: CURRENT_TABLE,
            referencedColumns: ['tenant_id', 'author_user_id', 'id'],
            onUpdate: 'restrict',
            onDelete: 'restrict'
          }
        ],
        indexes: []
      }
    ],
    views: [],
    triggers: [],
    routines: [],
    extensions: [],
    grants: []
  };
}

function statements(schemaName) {
  const current = qualified(schemaName, CURRENT_TABLE);
  const events = qualified(schemaName, EVENT_TABLE);
  return [
    `CREATE TABLE ${current} (
  tenant_id VARCHAR(128) NOT NULL,
  author_user_id VARCHAR(128) NOT NULL,
  id UUID NOT NULL,
  contract_version SMALLINT NOT NULL,
  version INTEGER NOT NULL,
  title VARCHAR(120) NOT NULL,
  entity VARCHAR(200) NOT NULL,
  year CHAR(4) NOT NULL,
  scope VARCHAR(12) NOT NULL,
  status VARCHAR(5) NOT NULL,
  access VARCHAR(16) NOT NULL,
  document_json TEXT NOT NULL,
  document_bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_budget_v2_current PRIMARY KEY (tenant_id, author_user_id, id),
  CONSTRAINT ck_budget_v2_current_tenant CHECK (btrim(tenant_id) <> '' AND tenant_id !~ '[^ -~]'),
  CONSTRAINT ck_budget_v2_current_author CHECK (btrim(author_user_id) <> '' AND author_user_id !~ '[^ -~]'),
  CONSTRAINT ck_budget_v2_current_contract CHECK (contract_version = 2),
  CONSTRAINT ck_budget_v2_current_version CHECK (version BETWEEN 1 AND 1000000),
  CONSTRAINT ck_budget_v2_current_title CHECK (btrim(title) <> ''),
  CONSTRAINT ck_budget_v2_current_entity CHECK (btrim(entity) <> ''),
  CONSTRAINT ck_budget_v2_current_year CHECK (year ~ '^[0-9]{4}$'),
  CONSTRAINT ck_budget_v2_current_scope CHECK (scope = 'organization'),
  CONSTRAINT ck_budget_v2_current_status CHECK (status = 'draft'),
  CONSTRAINT ck_budget_v2_current_access CHECK (access = 'owner-only'),
  CONSTRAINT ck_budget_v2_current_document_bytes CHECK (
    document_bytes BETWEEN 1 AND 4194304
    AND octet_length(document_json) = document_bytes
  ),
  CONSTRAINT ck_budget_v2_current_timeline CHECK (created_at <= updated_at)
)`,
    `CREATE TABLE ${events} (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id VARCHAR(128) NOT NULL,
  actor_user_id VARCHAR(128) NOT NULL,
  draft_id UUID NOT NULL,
  version INTEGER NOT NULL,
  action VARCHAR(32) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_budget_v2_events PRIMARY KEY (event_id),
  CONSTRAINT uq_budget_v2_events_mutation UNIQUE (
    tenant_id, actor_user_id, draft_id, version, action
  ),
  CONSTRAINT ck_budget_v2_events_tenant CHECK (btrim(tenant_id) <> '' AND tenant_id !~ '[^ -~]'),
  CONSTRAINT ck_budget_v2_events_actor CHECK (btrim(actor_user_id) <> '' AND actor_user_id !~ '[^ -~]'),
  CONSTRAINT ck_budget_v2_events_version CHECK (version BETWEEN 1 AND 1000000),
  CONSTRAINT ck_budget_v2_events_action CHECK (
    action IN ('budget_v2_draft_created', 'budget_v2_draft_updated')
  ),
  CONSTRAINT fk_budget_v2_events_current FOREIGN KEY (
    tenant_id, actor_user_id, draft_id
  ) REFERENCES ${current} (tenant_id, author_user_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
)`,
    `CREATE INDEX ${quoted(LIST_INDEX)} ON ${current} (
  tenant_id ASC, author_user_id ASC, updated_at DESC, id ASC
)`
  ];
}

function assertSchemaName(schemaName) {
  if (schemaName !== SCHEMA_NAME) fail();
}

function buildBudgetV2PostgresOfflinePlan({ schemaName = SCHEMA_NAME } = {}) {
  assertSchemaName(schemaName);
  const unsignedPlan = {
    contractId: CONTRACT_ID,
    planVersion: PLAN_VERSION,
    engine: 'postgresql',
    schemaName,
    requiresExistingSchema: true,
    transactionIsolation: 'READ COMMITTED',
    applyMode: 'offline-only',
    statements: statements(schemaName),
    expectedCatalog: expectedCatalog(schemaName)
  };
  return deepFreeze({ ...unsignedPlan, fingerprint: fingerprint(unsignedPlan) });
}

function validateBudgetV2PostgresInspection(plan, inspection) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || plan.schemaName !== SCHEMA_NAME) fail();
  const expectedPlan = buildBudgetV2PostgresOfflinePlan({ schemaName: plan.schemaName });
  if (canonical(plan) !== canonical(expectedPlan)) fail();
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)
    || !Number.isInteger(inspection.postgresMajor)
    || inspection.postgresMajor < MIN_POSTGRES_MAJOR
    || inspection.postgresMajor > MAX_POSTGRES_MAJOR) fail();
  const { postgresMajor, ...catalog } = inspection;
  if (canonical(catalog) !== canonical(expectedPlan.expectedCatalog)) fail();
  return deepFreeze({ valid: true, fingerprint: expectedPlan.fingerprint, postgresMajor });
}

module.exports = {
  BudgetV2PostgresSchemaError,
  CONTRACT_ID,
  CURRENT_TABLE,
  EVENT_TABLE,
  LIST_INDEX,
  MAX_POSTGRES_MAJOR,
  MIN_POSTGRES_MAJOR,
  SCHEMA_NAME,
  buildBudgetV2PostgresOfflinePlan,
  validateBudgetV2PostgresInspection
};

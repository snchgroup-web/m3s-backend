'use strict';

const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { devDependencies } = require('../../package.json');
const {
  ACCESS_TABLE,
  AUDIT_TABLE,
  INDEX_NAMES,
  RELATION_TABLE,
  REVISION_TABLE,
  SCHEMA_NAME,
  VERSION_TABLE,
  buildBankAccountPostgresOfflinePlan,
  validateBankAccountPostgresOfflinePlan
} = require('../../bankAccountPostgresSchema');
const {
  DATABASE_NAME,
  INVENTORY_CONTRACT_ID,
  buildBankAccountPostgresPlan,
  validateBankAccountPostgresPlan
} = require('../../bankAccountPostgresPlanner');

const CONTRACT_ID = 'M3S-CB-1-D-C-A-001';
const OBSERVED_AT = '2026-09-12T12:00:00.000Z';
const GENERATED_AT = '2026-09-12T12:01:00.000Z';
const REQUEST_AT = '2026-09-12T12:15:00.000Z';
const TENANTS = Object.freeze(['TENANT-CB-TEST-A', 'TENANT-CB-TEST-B']);
const ACTORS = Object.freeze({
  'TENANT-CB-TEST-A': 'ACTOR-CB-TEST-A',
  'TENANT-CB-TEST-B': 'ACTOR-CB-TEST-B'
});
const TARGET = Object.freeze({
  targetRef: 'local-bank-ephemeral-001',
  environment: 'local-ephemeral',
  engine: 'postgresql',
  postgresMajor: 18,
  databaseName: DATABASE_NAME,
  schemaName: SCHEMA_NAME,
  databaseEncoding: 'UTF8',
  dataClassification: 'synthetic-masked-only'
});
const CONTROL_IDS = Object.freeze(Array.from({ length: 28 }, (_, index) => index + 1));
const EXPECTED_CONSTRAINT_DEFINITIONS_FINGERPRINT =
  'fd73b558d597c05cd68c5876ab27ae50c3d782f24100de266fb10103a89396b8';
const TABLES = Object.freeze({
  accounts: VERSION_TABLE,
  relations: RELATION_TABLE,
  revisions: REVISION_TABLE,
  access: ACCESS_TABLE,
  audit: AUDIT_TABLE
});
const COLUMNS = Object.freeze({
  accounts: Object.freeze([
    'tenant_id', 'bank_account_id', 'record_version', 'holder_entity_id',
    'holder_entity_source_revision', 'financial_institution_id',
    'financial_institution_source_revision', 'business_owner_agent_id',
    'business_owner_agent_source_revision', 'internal_label', 'internal_label_order',
    'account_type', 'currency', 'status', 'visible', 'masked_identifier',
    'classification', 'effective_from', 'effective_to', 'source_revision',
    'verified_at', 'created_at', 'replaced_at'
  ]),
  relations: Object.freeze([
    'tenant_id', 'relation_kind', 'reference_id', 'source_revision',
    'label_snapshot', 'active', 'visible', 'classification', 'effective_from',
    'effective_to', 'country_id', 'institution_type', 'created_at'
  ]),
  revisions: Object.freeze([
    'tenant_id', 'source_id', 'contract_version', 'data_classification',
    'environment_class', 'schema_fingerprint', 'source_revision', 'list_revision',
    'policy_revision', 'generation', 'updated_at'
  ]),
  access: Object.freeze([
    'tenant_id', 'actor_id', 'bank_account_id', 'policy_revision',
    'max_classification', 'active', 'effective_from', 'effective_to', 'created_at'
  ]),
  audit: Object.freeze([
    'tenant_id', 'event_id', 'bank_account_id', 'actor_server_id', 'operation',
    'result_code', 'before_version', 'after_version', 'occurred_at'
  ])
});

const EXPECTED_INDEXES = Object.freeze([
  [ACCESS_TABLE, INDEX_NAMES.access, false,
    `CREATE INDEX ${INDEX_NAMES.access} ON ${SCHEMA_NAME}.${ACCESS_TABLE} USING btree (tenant_id, actor_id, policy_revision, bank_account_id) WHERE (active IS TRUE)`,
    '(active IS TRUE)'],
  [ACCESS_TABLE, `pk_${ACCESS_TABLE}`, true,
    `CREATE UNIQUE INDEX pk_${ACCESS_TABLE} ON ${SCHEMA_NAME}.${ACCESS_TABLE} USING btree (tenant_id, actor_id, bank_account_id, policy_revision)`, null],
  [AUDIT_TABLE, INDEX_NAMES.audit, false,
    `CREATE INDEX ${INDEX_NAMES.audit} ON ${SCHEMA_NAME}.${AUDIT_TABLE} USING btree (tenant_id, bank_account_id, occurred_at DESC, event_id)`, null],
  [AUDIT_TABLE, `pk_${AUDIT_TABLE}`, true,
    `CREATE UNIQUE INDEX pk_${AUDIT_TABLE} ON ${SCHEMA_NAME}.${AUDIT_TABLE} USING btree (tenant_id, event_id)`, null],
  [REVISION_TABLE, `pk_${REVISION_TABLE}`, true,
    `CREATE UNIQUE INDEX pk_${REVISION_TABLE} ON ${SCHEMA_NAME}.${REVISION_TABLE} USING btree (tenant_id)`, null],
  [RELATION_TABLE, `pk_${RELATION_TABLE}`, true,
    `CREATE UNIQUE INDEX pk_${RELATION_TABLE} ON ${SCHEMA_NAME}.${RELATION_TABLE} USING btree (tenant_id, relation_kind, reference_id, source_revision)`, null],
  [VERSION_TABLE, INDEX_NAMES.filters, false,
    `CREATE INDEX ${INDEX_NAMES.filters} ON ${SCHEMA_NAME}.${VERSION_TABLE} USING btree (tenant_id, status, classification, account_type, currency, holder_entity_id, financial_institution_id, internal_label_order, bank_account_id) WHERE ((replaced_at IS NULL) AND ((status)::text = 'active'::text) AND (visible IS TRUE))`,
    "((replaced_at IS NULL) AND ((status)::text = 'active'::text) AND (visible IS TRUE))"],
  [VERSION_TABLE, INDEX_NAMES.list, false,
    `CREATE INDEX ${INDEX_NAMES.list} ON ${SCHEMA_NAME}.${VERSION_TABLE} USING btree (tenant_id, internal_label_order, bank_account_id) WHERE ((replaced_at IS NULL) AND ((status)::text = 'active'::text) AND (visible IS TRUE))`,
    "((replaced_at IS NULL) AND ((status)::text = 'active'::text) AND (visible IS TRUE))"],
  [VERSION_TABLE, `pk_${VERSION_TABLE}`, true,
    `CREATE UNIQUE INDEX pk_${VERSION_TABLE} ON ${SCHEMA_NAME}.${VERSION_TABLE} USING btree (tenant_id, bank_account_id, record_version)`, null],
  [VERSION_TABLE, INDEX_NAMES.current, true,
    `CREATE UNIQUE INDEX ${INDEX_NAMES.current} ON ${SCHEMA_NAME}.${VERSION_TABLE} USING btree (tenant_id, bank_account_id) WHERE (replaced_at IS NULL)`,
    '(replaced_at IS NULL)']
].map(([table_name, index_name, indisunique, definition, predicate]) => ({
  table_name, index_name, indisunique, definition, predicate
})));

class BankAccountPGliteProofError extends Error {
  constructor() {
    super('Bank account ephemeral proof failed');
    Object.defineProperties(this, {
      name: { value: 'BankAccountPGliteProofError', configurable: true },
      code: { value: 'BANK_ACCOUNT_EPHEMERAL_PROOF_FAILED', enumerable: true }
    });
  }
}

const fail = () => { throw new BankAccountPGliteProofError(); };

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

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function uuid(suffix) {
  return `00000000-0000-4000-8000-0000000000${suffix}`;
}

function account({
  tenant, id, version = 1, label, classification = 'C2', visible = true,
  status = 'active', replacedAt = null, currency = 'CHF',
  holderEntityId = null, institutionId = null,
  accountType = 'OPERATING_CURRENT'
}) {
  const marker = id.slice(-2).toUpperCase();
  const lowerTenant = tenant.endsWith('-A') ? 'a' : 'b';
  return {
    tenant_id: tenant,
    bank_account_id: id,
    record_version: version,
    holder_entity_id: holderEntityId || `HOLDER-${lowerTenant.toUpperCase()}`,
    holder_entity_source_revision: holderEntityId
      ? `holder-${lowerTenant}-2-rev-1` : `holder-${lowerTenant}-rev-1`,
    financial_institution_id: institutionId || `INSTITUTION-${lowerTenant.toUpperCase()}`,
    financial_institution_source_revision: institutionId
      ? `institution-${lowerTenant}-2-rev-1` : `institution-${lowerTenant}-rev-1`,
    business_owner_agent_id: `AGENT-${lowerTenant.toUpperCase()}`,
    business_owner_agent_source_revision: `agent-${lowerTenant}-rev-1`,
    internal_label: label,
    internal_label_order: label,
    account_type: accountType,
    currency,
    status,
    visible,
    masked_identifier: `********${marker}`,
    classification,
    effective_from: '2026-01-01',
    effective_to: null,
    source_revision: `source-${lowerTenant}-rev-1`,
    verified_at: status === 'active' ? '2026-01-02T10:00:00.000Z' : null,
    created_at: version === 1
      ? '2026-01-02T10:00:00.000Z' : '2026-06-01T10:00:00.000Z',
    replaced_at: replacedAt
  };
}

function relationsFor(tenant) {
  const marker = tenant.endsWith('-A') ? 'A' : 'B';
  const lower = marker.toLowerCase();
  const common = {
    tenant_id: tenant,
    active: true,
    visible: true,
    classification: 'C2',
    effective_from: '2026-01-01',
    effective_to: null,
    created_at: '2026-01-01T10:00:00.000Z'
  };
  const rows = [
    {
      ...common,
      relation_kind: 'holder_entity',
      reference_id: `HOLDER-${marker}`,
      source_revision: `holder-${lower}-rev-1`,
      label_snapshot: `Titulaire fictif ${marker}`,
      country_id: null,
      institution_type: null
    },
    {
      ...common,
      relation_kind: 'financial_institution',
      reference_id: `INSTITUTION-${marker}`,
      source_revision: `institution-${lower}-rev-1`,
      label_snapshot: `Etablissement fictif ${marker}`,
      country_id: marker === 'A' ? 'CH' : 'SN',
      institution_type: 'bank'
    },
    {
      ...common,
      relation_kind: 'business_owner_agent',
      reference_id: `AGENT-${marker}`,
      source_revision: `agent-${lower}-rev-1`,
      label_snapshot: `Agent fictif ${marker}`,
      country_id: null,
      institution_type: null
    }
  ];
  if (marker === 'A') {
    rows.push(
      {
        ...common,
        relation_kind: 'holder_entity',
        reference_id: 'HOLDER-A2',
        source_revision: 'holder-a-2-rev-1',
        label_snapshot: 'Titulaire fictif A2',
        country_id: null,
        institution_type: null
      },
      {
        ...common,
        relation_kind: 'financial_institution',
        reference_id: 'INSTITUTION-A2',
        source_revision: 'institution-a-2-rev-1',
        label_snapshot: 'Etablissement fictif A2',
        country_id: 'CH',
        institution_type: 'payment_institution'
      }
    );
  }
  return rows;
}

function buildSyntheticCorpus(schemaFingerprint) {
  const a1 = uuid('a1');
  const a2 = uuid('a2');
  const a3 = uuid('a3');
  const b1 = uuid('b1');
  const b2 = uuid('b2');
  const b3 = uuid('b3');
  const currentA1 = account({
    tenant: TENANTS[0], id: a1, version: 2, label: '\uE000'
  });
  const rows = {
    accounts: [
      account({
        tenant: TENANTS[0], id: a1, version: 1, label: '\uE000',
        replacedAt: '2026-06-01T10:00:00.000Z'
      }),
      currentA1,
      account({
        tenant: TENANTS[0], id: a2, label: '\u{10000}', classification: 'C3',
        holderEntityId: 'HOLDER-A2', institutionId: 'INSTITUTION-A2',
        accountType: 'PROJECT_DEDICATED', currency: 'EUR'
      }),
      account({
        tenant: TENANTS[0], id: a3, label: 'Invisible fictif', visible: false,
        replacedAt: '2026-07-01T10:00:00.000Z'
      }),
      account({ tenant: TENANTS[1], id: b1, label: 'Compte fictif B1', currency: 'XOF' }),
      account({ tenant: TENANTS[1], id: b2, label: 'Compte fictif B2', visible: false }),
      account({
        tenant: TENANTS[1], id: b3, label: 'Compte fictif B3',
        classification: 'C3'
      })
    ],
    relations: [...relationsFor(TENANTS[0]), ...relationsFor(TENANTS[1])],
    revisions: TENANTS.map((tenant, index) => {
      const marker = index === 0 ? 'a' : 'b';
      return {
        tenant_id: tenant,
        source_id: `source-${marker}`,
        contract_version: 'M3S-CB-1',
        data_classification: 'SYNTHETIC_MASKED_ONLY',
        environment_class: 'LOCAL_EPHEMERAL',
        schema_fingerprint: schemaFingerprint,
        source_revision: `source-${marker}-rev-1`,
        list_revision: `list-${marker}-rev-1`,
        policy_revision: `policy-${marker}-rev-1`,
        generation: 1,
        updated_at: '2026-09-12T12:00:00.000Z'
      };
    }),
    access: [
      [TENANTS[0], ACTORS[TENANTS[0]], a1, 'policy-a-rev-1', 'C2', true],
      [TENANTS[0], ACTORS[TENANTS[0]], a2, 'policy-a-rev-1', 'C3', true],
      [TENANTS[0], ACTORS[TENANTS[0]], a3, 'policy-a-rev-1', 'C2', true],
      [TENANTS[0], ACTORS[TENANTS[0]], a1, 'policy-a-old', 'C3', true],
      [TENANTS[1], ACTORS[TENANTS[1]], b1, 'policy-b-rev-1', 'C2', true],
      [TENANTS[1], ACTORS[TENANTS[1]], b2, 'policy-b-rev-1', 'C2', true],
      [TENANTS[1], ACTORS[TENANTS[1]], b3, 'policy-b-rev-1', 'C2', true]
    ].map(([tenant_id, actor_id, bank_account_id, policy_revision,
      max_classification, active]) => ({
      tenant_id,
      actor_id,
      bank_account_id,
      policy_revision,
      max_classification,
      active,
      effective_from: '2026-01-01T00:00:00.000Z',
      effective_to: null,
      created_at: '2026-01-01T00:00:00.000Z'
    })),
    audit: [{
      tenant_id: TENANTS[0],
      event_id: uuid('e1'),
      bank_account_id: a1,
      actor_server_id: 'SERVER-CB-TEST-A',
      operation: 'updated',
      result_code: 'accepted',
      before_version: 1,
      after_version: 2,
      occurred_at: '2026-06-01T10:00:00.000Z'
    }]
  };
  return freeze(rows);
}

function validateSyntheticCorpus(corpus) {
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)
    || canonical(Object.keys(corpus).sort())
      !== canonical(['access', 'accounts', 'audit', 'relations', 'revisions'])) fail();
  const allRows = Object.values(corpus).flat();
  if (allRows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail();
  const observedTenants = new Set(allRows.map(row => row.tenant_id));
  if (observedTenants.size !== 2 || TENANTS.some(tenant => !observedTenants.has(tenant))) fail();

  const forbiddenValue = /(?:\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b|\b(?:iban|password|secret|token|statement|transaction|balance|cvv|pin|otp)\b|account[ _-]?number)/i;
  for (const row of allRows) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue;
      const compactValue = value.replace(/[^A-Z0-9]/gi, '');
      if (forbiddenValue.test(value)
        || /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/i.test(compactValue)) fail();
      if (!['bank_account_id', 'event_id', 'schema_fingerprint', 'masked_identifier',
        'created_at', 'updated_at', 'occurred_at', 'verified_at', 'replaced_at',
        'effective_from', 'effective_to'].includes(key)
        && /\d{8,}/.test(value)) fail();
    }
  }

  const accountIds = new Map(TENANTS.map(tenant => [tenant, new Set()]));
  for (const row of corpus.accounts) {
    accountIds.get(row.tenant_id)?.add(row.bank_account_id);
    if (!/^\*{4,30}[A-Za-z0-9]{0,4}$/.test(row.masked_identifier || '')) fail();
  }
  if ([...accountIds.values()].some(ids => ids.size < 1 || ids.size > 3)) fail();
  return true;
}

function typeName(column) {
  return ({
    varchar: 'character varying',
    char: 'character',
    timestamptz: 'timestamp with time zone'
  })[column.type] || column.type;
}

function expectedColumns(schemaPlan) {
  return schemaPlan.expectedCatalog.tables.flatMap(table => table.columns.map(
    (column, index) => ({
      table_name: table.name,
      column_name: column.name,
      data_type: typeName(column),
      character_maximum_length: column.length || null,
      datetime_precision: column.type === 'timestamptz' ? 6
        : (column.type === 'date' ? 0 : null),
      column_default: null,
      is_nullable: column.nullable ? 'YES' : 'NO',
      collation_name: column.collation || null,
      is_identity: 'NO',
      identity_generation: null,
      is_generated: 'NEVER',
      generation_expression: null,
      ordinal_position: index + 1
    })
  )).sort((left, right) => left.table_name.localeCompare(right.table_name)
    || left.ordinal_position - right.ordinal_position);
}

function expectedConstraints(schemaPlan) {
  return schemaPlan.expectedCatalog.tables.flatMap(table => [
    ...table.constraints.map(item => ({
      table_name: table.name,
      conname: item.name,
      contype: 'c'
    })),
    {
      table_name: table.name,
      conname: `pk_${table.name}`,
      contype: 'p'
    }
  ]).sort((left, right) => left.table_name.localeCompare(right.table_name)
    || left.conname.localeCompare(right.conname));
}

function expectedRelations(schemaPlan) {
  return [
    ...schemaPlan.expectedCatalog.indexes.map(index => ({ relname: index.name, relkind: 'i' })),
    ...schemaPlan.expectedCatalog.tables.map(table => ({
      relname: `pk_${table.name}`,
      relkind: 'i'
    })),
    ...schemaPlan.expectedCatalog.tables.map(table => ({ relname: table.name, relkind: 'r' }))
  ].sort((left, right) => left.relkind.localeCompare(right.relkind)
    || left.relname.localeCompare(right.relname));
}

const METADATA_QUERIES = Object.freeze({
  schema: 'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists',
  relations: `SELECT c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 ORDER BY c.relkind, c.relname`,
  columns: `SELECT table_name, column_name, data_type, character_maximum_length,
      datetime_precision, column_default, is_nullable, collation_name, is_identity, identity_generation,
      is_generated, generation_expression, ordinal_position
    FROM information_schema.columns WHERE table_schema = $1
    ORDER BY table_name, ordinal_position`,
  constraints: `SELECT t.relname AS table_name, c.conname, c.contype,
      pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1 AND c.contype <> 'n' ORDER BY t.relname, c.conname`,
  indexes: `SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique,
      pg_get_indexdef(ix.indexrelid) AS definition,
      pg_get_expr(ix.indpred, ix.indrelid) AS predicate
    FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1 ORDER BY t.relname, i.relname`,
  triggers: `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname`,
  routines: `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 ORDER BY p.proname`,
  extensions: `SELECT e.extname FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE n.nspname = $1 ORDER BY e.extname`,
  grants: `SELECT object_kind, object_name, column_name, acl
    FROM (
      SELECT 'schema'::text AS object_kind, n.nspname AS object_name,
        NULL::text AS column_name, n.nspacl::text AS acl
      FROM pg_namespace n
      WHERE n.nspname = $1 AND n.nspacl IS NOT NULL
      UNION ALL
      SELECT 'table'::text, c.relname, NULL::text, c.relacl::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relacl IS NOT NULL
      UNION ALL
      SELECT 'column'::text, c.relname, a.attname, a.attacl::text
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    ) privilege_acl
    ORDER BY object_kind, object_name, column_name`
});

function inventoryFields(schemaState, catalog, catalogFingerprint, unexpectedObjects) {
  return {
    targetRef: TARGET.targetRef,
    observedAt: OBSERVED_AT,
    inventoryContractId: INVENTORY_CONTRACT_ID,
    environment: TARGET.environment,
    engine: TARGET.engine,
    postgresMajor: TARGET.postgresMajor,
    databaseName: TARGET.databaseName,
    schemaName: TARGET.schemaName,
    databaseEncoding: TARGET.databaseEncoding,
    dataClassification: TARGET.dataClassification,
    schemaState,
    catalog,
    catalogFingerprint,
    unexpectedObjects
  };
}

async function collectInventory(database, schemaPlan) {
  const version = await database.query('SHOW server_version');
  const encoding = await database.query('SHOW server_encoding');
  if (Number.parseInt(version.rows[0].server_version, 10) !== TARGET.postgresMajor
    || encoding.rows[0].server_encoding !== TARGET.databaseEncoding) fail();
  const schema = await database.query(METADATA_QUERIES.schema, [SCHEMA_NAME]);
  if (schema.rows[0].exists !== true) return inventoryFields('missing', null, null, []);

  const metadata = {};
  for (const [name, query] of Object.entries(METADATA_QUERIES)) {
    if (name !== 'schema') metadata[name] = (await database.query(query, [SCHEMA_NAME])).rows;
  }
  const objectCount = metadata.relations.length + metadata.triggers.length
    + metadata.routines.length + metadata.extensions.length + metadata.grants.length;
  if (objectCount === 0) return inventoryFields('empty', null, null, []);

  const constraintIdentities = metadata.constraints.map(
    ({ table_name, conname, contype }) => ({ table_name, conname, contype })
  );
  const conformant = canonical(metadata.relations) === canonical(expectedRelations(schemaPlan))
    && canonical(metadata.columns) === canonical(expectedColumns(schemaPlan))
    && canonical(constraintIdentities) === canonical(expectedConstraints(schemaPlan))
    && fingerprint(metadata.constraints) === EXPECTED_CONSTRAINT_DEFINITIONS_FINGERPRINT
    && canonical(metadata.indexes) === canonical(EXPECTED_INDEXES)
    && metadata.triggers.length === 0 && metadata.routines.length === 0
    && metadata.extensions.length === 0 && metadata.grants.length === 0;
  if (!conformant) return inventoryFields('divergent', null, null, ['catalog-drift']);
  const catalog = structuredClone(schemaPlan.expectedCatalog);
  return inventoryFields('conformant', catalog, fingerprint(catalog), []);
}

async function insertRows(transaction, kind, rows) {
  const columns = COLUMNS[kind];
  const table = TABLES[kind];
  if (!columns || !table) fail();
  const parameters = columns.map((_, index) => `$${index + 1}`).join(', ');
  const sql = `INSERT INTO "${SCHEMA_NAME}"."${table}" (${columns.join(', ')}) VALUES (${parameters})`;
  for (const row of rows) {
    if (canonical(Object.keys(row).sort()) !== canonical([...columns].sort())) fail();
    await transaction.query(sql, columns.map(column => row[column]));
  }
}

async function loadCorpus(database, corpus) {
  await database.transaction(async transaction => {
    for (const kind of ['relations', 'revisions', 'accounts', 'access', 'audit']) {
      await insertRows(transaction, kind, corpus[kind]);
    }
  });
}

function queryByCode(schemaPlan, code) {
  const query = schemaPlan.queries.find(item => item.code === code);
  if (!query) fail();
  return query;
}

async function boundedQuery(database, query, params) {
  if (query.mode !== 'read-only' || params.length !== query.parameterCount
    || params.some(value => value === undefined)) fail();
  if (query.code === 'Q-03'
    && (!Number.isInteger(params[14]) || params[14] < 1 || params[14] > 51)) fail();
  const result = await database.query(query.text, params);
  if (!Array.isArray(result.rows) || result.rows.length > query.maxRows) fail();
  return result.rows;
}

function listParams(tenant, actor, overrides = {}) {
  const marker = tenant.endsWith('-A') ? 'a' : 'b';
  return [
    tenant,
    actor,
    REQUEST_AT,
    `policy-${marker}-rev-1`,
    overrides.holderEntityId ?? null,
    overrides.financialInstitutionId ?? null,
    overrides.accountType ?? null,
    overrides.currency ?? null,
    overrides.status ?? null,
    overrides.classification ?? null,
    overrides.afterLabel ?? null,
    overrides.afterId ?? null,
    `list-${marker}-rev-1`,
    `source-${marker}-rev-1`,
    overrides.limit ?? 51
  ];
}

function totalParams(list) {
  return [...list.slice(0, 10), list[12], list[13]];
}

function passedControls(set) {
  return CONTROL_IDS.every(id => set.has(id));
}

function sanitizedReport(controls, verdict, cleanupVerified) {
  return freeze({
    contractId: CONTRACT_ID,
    engine: 'pglite-postgresql',
    storageMode: 'memory-only',
    dataClassification: 'synthetic-masked-only',
    controlCount: controls.size,
    passedControls: [...controls].sort((left, right) => left - right),
    cleanupVerified,
    verdict
  });
}

async function runBankAccountPGliteProof({ corpusFactory = buildSyntheticCorpus } = {}) {
  const controls = new Set();
  let database;
  let cleanupVerified = false;
  let verdict = 'FAIL-CONTRACT';
  let stage = 'preflight';
  try {
    if (devDependencies['@electric-sql/pglite'] !== '0.5.7') fail();
    controls.add(1);
    if (typeof PGlite !== 'function') fail();
    controls.add(2);

    const schemaPlan = buildBankAccountPostgresOfflinePlan();
    validateBankAccountPostgresOfflinePlan(schemaPlan);
    const corpus = corpusFactory(schemaPlan.fingerprint);
    validateSyntheticCorpus(corpus);
    controls.add(4);
    controls.add(5);

    stage = 'engine-startup';
    database = new PGlite();
    controls.add(3);
    await database.exec(`CREATE SCHEMA "${SCHEMA_NAME}"`);
    const emptyInventory = await collectInventory(database, schemaPlan);
    if (emptyInventory.schemaState !== 'empty') fail();
    controls.add(11);

    const createPlan = buildBankAccountPostgresPlan({
      schemaPlan,
      target: TARGET,
      inventory: emptyInventory,
      generatedAt: GENERATED_AT
    });
    validateBankAccountPostgresPlan(createPlan);
    if (createPlan.executionAuthorized !== false) fail();
    controls.add(6);
    if (createPlan.outcome !== 'planned-create') fail();
    controls.add(7);
    if (createPlan.destructiveStatements.length !== 0) fail();
    controls.add(8);
    if (canonical(createPlan.statements) !== canonical(schemaPlan.statements)) fail();
    controls.add(9);

    stage = 'schema-apply';
    await database.transaction(async transaction => {
      for (const statement of createPlan.statements) await transaction.exec(statement);
    });
    const conformantInventory = await collectInventory(database, schemaPlan);
    if (conformantInventory.schemaState !== 'conformant') fail();
    controls.add(10);
    const noopPlan = buildBankAccountPostgresPlan({
      schemaPlan,
      target: TARGET,
      inventory: { ...conformantInventory, observedAt: OBSERVED_AT },
      generatedAt: GENERATED_AT
    });
    if (noopPlan.outcome !== 'planned-noop' || noopPlan.statements.length !== 0) fail();
    controls.add(12);

    stage = 'proof';
    await loadCorpus(database, corpus);
    const q1 = queryByCode(schemaPlan, 'Q-01');
    const q2 = queryByCode(schemaPlan, 'Q-02');
    const q3 = queryByCode(schemaPlan, 'Q-03');
    const q4 = queryByCode(schemaPlan, 'Q-04');
    const q5 = queryByCode(schemaPlan, 'Q-05');
    const q6 = queryByCode(schemaPlan, 'Q-06');
    const firstA = corpus.accounts.find(row => row.tenant_id === TENANTS[0]
      && row.record_version === 2);
    const exactAccount = await boundedQuery(database, q1, [
      TENANTS[0], firstA.bank_account_id, REQUEST_AT
    ]);
    const wrongTenantAccount = await boundedQuery(database, q1, [
      TENANTS[1], firstA.bank_account_id, REQUEST_AT
    ]);
    if (exactAccount.length !== 1 || wrongTenantAccount.length !== 0) fail();
    const relation = await boundedQuery(database, q2, [
      TENANTS[0], 'holder_entity', 'HOLDER-A', 'holder-a-rev-1', REQUEST_AT
    ]);
    const wrongRevision = await boundedQuery(database, q2, [
      TENANTS[0], 'holder_entity', 'HOLDER-A', 'holder-a-rev-2', REQUEST_AT
    ]);
    if (relation.length !== 1 || wrongRevision.length !== 0) fail();
    controls.add(15);

    const listAParams = listParams(TENANTS[0], ACTORS[TENANTS[0]]);
    const listA = await boundedQuery(database, q3, listAParams);
    if (listA.length !== 2) fail();
    const listBParams = listParams(TENANTS[1], ACTORS[TENANTS[1]]);
    const listB = await boundedQuery(database, q3, listBParams);
    if (listB.length !== 1 || listB[0].bank_account_id !== uuid('b1')) fail();
    const classificationDeniedBParams = listParams(
      TENANTS[1], ACTORS[TENANTS[1]], { classification: 'C3' }
    );
    const classificationDeniedB = await boundedQuery(database, q3, classificationDeniedBParams);
    if (classificationDeniedB.length !== 0) fail();
    const stale = listParams(TENANTS[0], ACTORS[TENANTS[0]]);
    stale[3] = 'policy-a-old';
    stale[12] = 'list-a-rev-1';
    stale[13] = 'source-a-rev-1';
    if ((await boundedQuery(database, q3, stale)).length !== 0) fail();
    controls.add(16);
    if (!listA.some(row => row.bank_account_id === uuid('a2'))) fail();
    controls.add(17);

    for (const [filter, expectedIds] of [
      [{ holderEntityId: 'HOLDER-A' }, [uuid('a1')]],
      [{ financialInstitutionId: 'INSTITUTION-A' }, [uuid('a1')]],
      [{ accountType: 'OPERATING_CURRENT' }, [uuid('a1')]],
      [{ currency: 'CHF' }, [uuid('a1')]],
      [{ status: 'active' }, [uuid('a1'), uuid('a2')]],
      [{ classification: 'C3' }, [uuid('a2')]]
    ]) {
      const rows = await boundedQuery(
        database, q3, listParams(TENANTS[0], ACTORS[TENANTS[0]], filter)
      );
      if (canonical(rows.map(row => row.bank_account_id)) !== canonical(expectedIds)) fail();
    }
    const noFilterMatch = await boundedQuery(
      database, q3, listParams(TENANTS[0], ACTORS[TENANTS[0]], {
        holderEntityId: 'HOLDER-NO-MATCH'
      })
    );
    if (noFilterMatch.length !== 0) fail();
    controls.add(18);

    const firstPage = await boundedQuery(
      database, q3, listParams(TENANTS[0], ACTORS[TENANTS[0]], { limit: 1 })
    );
    const secondPage = await boundedQuery(database, q3, listParams(
      TENANTS[0], ACTORS[TENANTS[0]], {
        afterLabel: firstPage[0].internal_label_order,
        afterId: firstPage[0].bank_account_id,
        limit: 1
      }
    ));
    if (firstPage.length !== 1 || secondPage.length !== 1
      || firstPage[0].bank_account_id === secondPage[0].bank_account_id) fail();
    let limitClosed = false;
    try {
      await boundedQuery(
        database, q3, listParams(TENANTS[0], ACTORS[TENANTS[0]], { limit: 52 })
      );
    } catch (error) {
      limitClosed = error instanceof BankAccountPGliteProofError;
    }
    if (!limitClosed) fail();
    controls.add(19);

    const totalA = await boundedQuery(database, q4, totalParams(listAParams));
    if (totalA[0].authorized_filtered_count !== listA.length) fail();
    const totalB = await boundedQuery(database, q4, totalParams(listBParams));
    if (totalB[0].authorized_filtered_count !== listB.length) fail();
    const classificationDeniedTotalB = await boundedQuery(
      database, q4, totalParams(classificationDeniedBParams)
    );
    if (classificationDeniedTotalB[0].authorized_filtered_count !== 0) fail();
    controls.add(20);
    const zeroParams = listParams(TENANTS[0], ACTORS[TENANTS[0]], { currency: 'JPY' });
    const zero = await boundedQuery(database, q4, totalParams(zeroParams));
    let unavailable = false;
    try {
      await boundedQuery({ query: async () => { throw new Error('driver detail'); } }, q4, totalParams(zeroParams));
    } catch (_error) {
      unavailable = true;
    }
    if (zero[0].authorized_filtered_count !== 0 || !unavailable) fail();
    controls.add(21);
    if (firstPage[0].internal_label_order !== '\uE000'
      || secondPage[0].internal_label_order !== '\u{10000}') fail();
    controls.add(22);
    if (schemaPlan.queries.some(query => query.parameterCount < 1
      || /TENANT-CB-TEST|ACTOR-CB-TEST|HOLDER-A|INSTITUTION-A/.test(query.text))) fail();
    controls.add(23);

    const crossA = await boundedQuery(
      database, q3, listParams(TENANTS[0], ACTORS[TENANTS[1]])
    );
    const crossB = await boundedQuery(
      database, q3, listParams(TENANTS[1], ACTORS[TENANTS[0]])
    );
    if (crossA.length !== 0 || crossB.length !== 0) fail();
    controls.add(24);

    const historyBefore = await database.query(
      `SELECT record_version, replaced_at FROM "${SCHEMA_NAME}"."${VERSION_TABLE}"
       WHERE tenant_id = $1 AND bank_account_id = $2 ORDER BY record_version`,
      [TENANTS[0], firstA.bank_account_id]
    );
    if (historyBefore.rows.length !== 2 || historyBefore.rows[0].replaced_at === null
      || historyBefore.rows[1].replaced_at !== null) fail();
    const writeQueries = schemaPlan.queries.filter(query => query.mode !== 'read-only');
    if (writeQueries.length !== 1 || writeQueries[0].code !== 'Q-07'
      || !/^INSERT\s/i.test(writeQueries[0].text)
      || schemaPlan.statements.some(statement => /\b(?:UPDATE|DELETE)\b/i.test(statement))) fail();
    controls.add(14);

    const historicalOnly = corpus.accounts.find(row => row.bank_account_id === uuid('a3'));
    const competing = [
      { version: 2, eventId: uuid('e2'), createdAt: '2026-09-12T12:20:00.000Z' },
      { version: 3, eventId: uuid('e3'), createdAt: '2026-09-12T12:21:00.000Z' }
    ];
    const outcomes = await Promise.allSettled(competing.map(candidate => (
      database.transaction(async transaction => {
        await insertRows(transaction, 'audit', [{
          ...corpus.audit[0],
          event_id: candidate.eventId,
          bank_account_id: historicalOnly.bank_account_id,
          before_version: 1,
          after_version: candidate.version
        }]);
        await insertRows(transaction, 'accounts', [{
          ...historicalOnly,
          record_version: candidate.version,
          created_at: candidate.createdAt,
          replaced_at: null
        }]);
      })
    )));
    const currentAfterRace = await database.query(
      `SELECT COUNT(*)::integer AS count FROM "${SCHEMA_NAME}"."${VERSION_TABLE}"
       WHERE tenant_id = $1 AND bank_account_id = $2 AND replaced_at IS NULL`,
      [TENANTS[0], historicalOnly.bank_account_id]
    );
    const auditAfterRace = await database.query(
      `SELECT COUNT(*)::integer AS count FROM "${SCHEMA_NAME}"."${AUDIT_TABLE}"
       WHERE tenant_id = $1 AND bank_account_id = $2`,
      [TENANTS[0], historicalOnly.bank_account_id]
    );
    if (outcomes.filter(item => item.status === 'fulfilled').length !== 1
      || outcomes.filter(item => item.status === 'rejected').length !== 1
      || currentAfterRace.rows[0].count !== 1 || auditAfterRace.rows[0].count !== 1) fail();
    controls.add(13);
    controls.add(25);

    const auditColumns = (await database.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [SCHEMA_NAME, AUDIT_TABLE]
    )).rows.map(row => row.column_name);
    const auditRows = (await database.query(
      `SELECT * FROM "${SCHEMA_NAME}"."${AUDIT_TABLE}" WHERE tenant_id = $1`,
      [TENANTS[0]]
    )).rows;
    if (canonical(auditColumns) !== canonical(COLUMNS.audit)
      || /label|mask|payload|amount|iban|balance|transaction/i.test(canonical(auditRows))) fail();
    controls.add(26);

    const revisions = await boundedQuery(database, q5, [TENANTS[0]]);
    const source = await boundedQuery(database, q6, [TENANTS[0]]);
    if (revisions.length !== 1 || source.length !== 1) fail();
    const generic = new BankAccountPGliteProofError();
    if (/SELECT|INSERT|finance_bank_accounts|driver detail/i.test(`${generic.message} ${generic.stack}`)) fail();
    controls.add(27);
    verdict = passedControls(new Set([...controls, 28])) ? 'PASS-EPHEMERAL' : 'FAIL-CONTRACT';
  } catch (error) {
    const compatibilityFailure = ['engine-startup', 'schema-apply'].includes(stage)
      && error && typeof error.message === 'string'
      && /(?:unsupported|not supported|webassembly|wasm)/i.test(error.message);
    verdict = compatibilityFailure ? 'BLOCKED-COMPATIBILITY' : 'FAIL-CONTRACT';
  } finally {
    if (database) {
      let closeSucceeded = false;
      try {
        await database.close();
        closeSucceeded = true;
      } catch (_error) {
        closeSucceeded = false;
      }
      try {
        await database.query('SELECT 1');
      } catch (_error) {
        cleanupVerified = closeSucceeded;
      }
    }
  }
  if (cleanupVerified) controls.add(28);
  if (!cleanupVerified && verdict === 'PASS-EPHEMERAL') verdict = 'FAIL-CLEANUP';
  if (!passedControls(controls) && verdict === 'PASS-EPHEMERAL') verdict = 'FAIL-CONTRACT';
  return sanitizedReport(controls, verdict, cleanupVerified);
}

module.exports = {
  BankAccountPGliteProofError,
  CONTRACT_ID,
  CONTROL_IDS,
  TARGET,
  TENANTS,
  buildSyntheticCorpus,
  collectInventory,
  runBankAccountPGliteProof,
  validateSyntheticCorpus
};

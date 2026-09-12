'use strict';

const crypto = require('node:crypto');
const { types: { isProxy } } = require('node:util');
const {
  ACCOUNT_CLASSIFICATIONS,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  INSTITUTION_TYPES,
  ISO_4217_CODES
} = require('./bankAccountContracts');

const CONTRACT_ID = 'M3S-CB-1-D-B-A-001';
const PLAN_VERSION = 1;
const SCHEMA_NAME = 'finance_bank_accounts';
const VERSION_TABLE = 'bank_account_versions';
const RELATION_TABLE = 'bank_account_relation_snapshots';
const REVISION_TABLE = 'bank_account_registry_revisions';
const ACCESS_TABLE = 'bank_account_access_projections';
const AUDIT_TABLE = 'bank_account_audit_events';
const MIN_POSTGRES_MAJOR = 16;
const MAX_POSTGRES_MAJOR = 18;
const MAX_DATA_DEPTH = 64;
const MAX_DATA_NODES = 20000;

const INDEX_NAMES = Object.freeze({
  current: 'uq_bank_account_versions_current',
  list: 'ix_bank_account_versions_list',
  filters: 'ix_bank_account_versions_filters',
  access: 'ix_bank_account_access_lookup',
  audit: 'ix_bank_account_audit_timeline'
});

const FORBIDDEN_COLUMN_NAMES = Object.freeze([
  'iban', 'account_number', 'pan', 'card_number', 'card_expiry', 'cvv',
  'balance', 'statement', 'transaction', 'password', 'pin', 'otp',
  'token', 'secret', 'payment_order', 'transfer_beneficiary'
]);

class BankAccountPostgresSchemaError extends Error {
  constructor() {
    super('Invalid bank account PostgreSQL offline schema plan');
    Object.defineProperties(this, {
      name: { value: 'BankAccountPostgresSchemaError', configurable: true },
      code: { value: 'BANK_ACCOUNT_POSTGRES_SCHEMA_INVALID', enumerable: true }
    });
  }
}

const fail = () => { throw new BankAccountPostgresSchemaError(); };

function isPlainData(value) {
  const stack = [{ value, depth: 0, exit: false }];
  const active = new Set();
  let nodeCount = 0;

  while (stack.length > 0) {
    const item = stack.pop();
    const candidate = item.value;
    if (item.exit) {
      active.delete(candidate);
      continue;
    }
    if (candidate === null || ['string', 'boolean'].includes(typeof candidate)) continue;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || item.depth > MAX_DATA_DEPTH) return false;
    try {
      if (isProxy(candidate) || active.has(candidate)) return false;
    } catch (_error) {
      return false;
    }
    nodeCount += 1;
    if (nodeCount > MAX_DATA_NODES) return false;

    let prototype;
    let keys;
    try {
      prototype = Object.getPrototypeOf(candidate);
      keys = Reflect.ownKeys(candidate);
    } catch (_error) {
      return false;
    }
    if (prototype !== Object.prototype && prototype !== Array.prototype) return false;
    if (Array.isArray(candidate) && keys.length !== candidate.length + 1) return false;

    active.add(candidate);
    stack.push({ value: candidate, depth: item.depth, exit: true });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (typeof key !== 'string') return false;
      if (Array.isArray(candidate) && key === 'length') continue;
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      } catch (_error) {
        return false;
      }
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
      stack.push({ value: descriptor.value, depth: item.depth + 1, exit: false });
    }
  }
  return true;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalUnsafe(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalUnsafe).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalUnsafe(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonical(value) {
  if (!isPlainData(value)) fail();
  return canonicalUnsafe(value);
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

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlList(values) {
  return values.map(sqlLiteral).join(', ');
}

function sqlCharacterClass(ranges) {
  const parts = ranges.map(([start, end]) => (
    end === undefined ? `chr(${start})` : `chr(${start}) || '-' || chr(${end})`
  ));
  return `('[' || ${parts.join(' || ')} || ']')`;
}

const SQL_UNSAFE_TEXT_CLASS = sqlCharacterClass([
  [173], [1536, 1541], [1564], [1757], [1807], [2192, 2193], [2274], [6158],
  [8203, 8207], [8232, 8238], [8288, 8292], [8294, 8303], [65279],
  [65529, 65531], [69821], [69837], [78896, 78933], [113824, 113827],
  [119155, 119162], [917505], [917536, 917631]
]);
const SQL_SUPPLEMENTARY_CLASS = sqlCharacterClass([[65536, 1114111]]);
const SQL_TRIM_CHARACTERS = `(
  chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160)
  || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)
  || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202)
  || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)
)`;

function displayTextSql(columnName) {
  if (!['internal_label', 'label_snapshot'].includes(columnName)) fail();
  return `${columnName} <> ''
    AND btrim(${columnName}, ${SQL_TRIM_CHARACTERS}) = ${columnName}
    AND ${columnName} IS NFC NORMALIZED
    AND ${columnName} !~ '[[:cntrl:]]'
    AND ${columnName} !~ ${SQL_UNSAFE_TEXT_CLASS}
    AND char_length(${columnName}) + (
      char_length(${columnName})
      - char_length(regexp_replace(${columnName}, ${SQL_SUPPLEMENTARY_CLASS}, '', 'g'))
    ) <= 120`;
}

const column = (name, type, options = {}) => ({
  name,
  type,
  nullable: false,
  length: null,
  collation: null,
  ...options
});

const constraint = (name, rule) => ({ name, type: 'check', rule });

function expectedIndexes() {
  return [
    {
      name: INDEX_NAMES.current,
      table: VERSION_TABLE,
      unique: true,
      columns: ['tenant_id', 'bank_account_id'],
      predicate: 'replaced_at IS NULL'
    },
    {
      name: INDEX_NAMES.list,
      table: VERSION_TABLE,
      unique: false,
      columns: ['tenant_id', 'internal_label_order COLLATE C', 'bank_account_id'],
      predicate: "replaced_at IS NULL AND status = 'active' AND visible IS TRUE"
    },
    {
      name: INDEX_NAMES.filters,
      table: VERSION_TABLE,
      unique: false,
      columns: [
        'tenant_id', 'status', 'classification', 'account_type', 'currency',
        'holder_entity_id', 'financial_institution_id',
        'internal_label_order COLLATE C', 'bank_account_id'
      ],
      predicate: "replaced_at IS NULL AND status = 'active' AND visible IS TRUE"
    },
    {
      name: INDEX_NAMES.access,
      table: ACCESS_TABLE,
      unique: false,
      columns: ['tenant_id', 'actor_id', 'policy_revision', 'bank_account_id'],
      predicate: 'active IS TRUE'
    },
    {
      name: INDEX_NAMES.audit,
      table: AUDIT_TABLE,
      unique: false,
      columns: ['tenant_id', 'bank_account_id', 'occurred_at DESC', 'event_id'],
      predicate: null
    }
  ];
}

function expectedCatalog(schemaName) {
  return {
    engine: 'postgresql',
    schemaName,
    databaseEncoding: 'UTF8',
    tables: [
      {
        name: VERSION_TABLE,
        columns: [
          column('tenant_id', 'varchar', { length: 128 }),
          column('bank_account_id', 'uuid'),
          column('record_version', 'integer'),
          column('holder_entity_id', 'varchar', { length: 128 }),
          column('holder_entity_source_revision', 'varchar', { length: 128 }),
          column('financial_institution_id', 'varchar', { length: 128 }),
          column('financial_institution_source_revision', 'varchar', { length: 128 }),
          column('business_owner_agent_id', 'varchar', { length: 128, nullable: true }),
          column('business_owner_agent_source_revision', 'varchar', {
            length: 128, nullable: true
          }),
          column('internal_label', 'varchar', { length: 120 }),
          column('internal_label_order', 'varchar', { length: 120, collation: 'C' }),
          column('account_type', 'varchar', { length: 32 }),
          column('currency', 'char', { length: 3 }),
          column('status', 'varchar', { length: 32 }),
          column('visible', 'boolean'),
          column('masked_identifier', 'varchar', { length: 34 }),
          column('classification', 'char', { length: 2 }),
          column('effective_from', 'date', { nullable: true }),
          column('effective_to', 'date', { nullable: true }),
          column('source_revision', 'varchar', { length: 128 }),
          column('verified_at', 'timestamptz', { nullable: true }),
          column('created_at', 'timestamptz'),
          column('replaced_at', 'timestamptz', { nullable: true })
        ],
        primaryKey: ['tenant_id', 'bank_account_id', 'record_version'],
        constraints: [
          constraint('ck_bank_account_versions_tenant',
            "tenant_id MATCHES SAFE_REFERENCE_128"),
          constraint('ck_bank_account_versions_record_version',
            'record_version BETWEEN 1 AND 1000000'),
          constraint('ck_bank_account_versions_references',
            'holder and institution ids and source revisions MATCH SAFE_REFERENCE_128'),
          constraint('ck_bank_account_versions_optional_owner',
            'owner id and source revision are both NULL or both MATCH SAFE_REFERENCE_128'),
          constraint('ck_bank_account_versions_labels',
            'internal_label MATCHES DISPLAY_TEXT_V1 and order EQUALS label COLLATE C'),
          constraint('ck_bank_account_versions_account_type',
            `account_type IN (${ACCOUNT_TYPES.join(',')})`),
          constraint('ck_bank_account_versions_currency',
            `currency IN (${ISO_4217_CODES.join(',')})`),
          constraint('ck_bank_account_versions_status',
            `status IN (${ACCOUNT_STATUSES.join(',')})`),
          constraint('ck_bank_account_versions_verification',
            'candidate or pending implies no verification; active, suspended or closed requires it'),
          constraint('ck_bank_account_versions_mask',
            'masked_identifier length 8..34 with at least four stars and at most four trailing chars'),
          constraint('ck_bank_account_versions_classification',
            `classification IN (${ACCOUNT_CLASSIFICATIONS.join(',')})`),
          constraint('ck_bank_account_versions_source_revision',
            'source_revision MATCHES SAFE_REFERENCE_128'),
          constraint('ck_bank_account_versions_effective_period',
            'effective_to is NULL or not before effective_from'),
          constraint('ck_bank_account_versions_replacement',
            'replaced_at is NULL or after created_at')
        ]
      },
      {
        name: RELATION_TABLE,
        columns: [
          column('tenant_id', 'varchar', { length: 128 }),
          column('relation_kind', 'varchar', { length: 32 }),
          column('reference_id', 'varchar', { length: 128 }),
          column('source_revision', 'varchar', { length: 128 }),
          column('label_snapshot', 'varchar', { length: 120 }),
          column('active', 'boolean'),
          column('visible', 'boolean'),
          column('classification', 'char', { length: 2 }),
          column('effective_from', 'date', { nullable: true }),
          column('effective_to', 'date', { nullable: true }),
          column('country_id', 'varchar', { length: 128, nullable: true }),
          column('institution_type', 'varchar', { length: 40, nullable: true }),
          column('created_at', 'timestamptz')
        ],
        primaryKey: ['tenant_id', 'relation_kind', 'reference_id', 'source_revision'],
        constraints: [
          constraint('ck_bank_account_relations_tenant',
            'tenant_id MATCHES SAFE_REFERENCE_128'),
          constraint('ck_bank_account_relations_kind',
            'relation_kind IN (holder_entity,financial_institution,business_owner_agent)'),
          constraint('ck_bank_account_relations_reference',
            'reference_id and source_revision MATCH SAFE_REFERENCE_128'),
          constraint('ck_bank_account_relations_label',
            'label_snapshot MATCHES DISPLAY_TEXT_V1'),
          constraint('ck_bank_account_relations_classification',
            `classification IN (${ACCOUNT_CLASSIFICATIONS.join(',')})`),
          constraint('ck_bank_account_relations_effective_period',
            'effective_to is NULL or not before effective_from'),
          constraint('ck_bank_account_relations_institution_fields',
            `institution has country and type IN (${INSTITUTION_TYPES.join(',')}); others have neither`)
        ]
      },
      {
        name: REVISION_TABLE,
        columns: [
          column('tenant_id', 'varchar', { length: 128 }),
          column('source_id', 'varchar', { length: 128 }),
          column('contract_version', 'varchar', { length: 64 }),
          column('data_classification', 'varchar', { length: 64 }),
          column('environment_class', 'varchar', { length: 64 }),
          column('schema_fingerprint', 'char', { length: 64 }),
          column('source_revision', 'varchar', { length: 128 }),
          column('list_revision', 'varchar', { length: 128 }),
          column('policy_revision', 'varchar', { length: 128 }),
          column('generation', 'bigint'),
          column('updated_at', 'timestamptz')
        ],
        primaryKey: ['tenant_id'],
        constraints: [
          constraint('ck_bank_account_revisions_identifiers',
            'tenant, source, contract and revisions use their closed identifier formats'),
          constraint('ck_bank_account_revisions_fingerprint',
            'schema_fingerprint MATCHES LOWER_HEX_64'),
          constraint('ck_bank_account_revisions_generation', 'generation >= 1')
        ]
      },
      {
        name: ACCESS_TABLE,
        columns: [
          column('tenant_id', 'varchar', { length: 128 }),
          column('actor_id', 'varchar', { length: 128 }),
          column('bank_account_id', 'uuid'),
          column('policy_revision', 'varchar', { length: 128 }),
          column('max_classification', 'char', { length: 2 }),
          column('active', 'boolean'),
          column('effective_from', 'timestamptz'),
          column('effective_to', 'timestamptz', { nullable: true }),
          column('created_at', 'timestamptz')
        ],
        primaryKey: ['tenant_id', 'actor_id', 'bank_account_id', 'policy_revision'],
        constraints: [
          constraint('ck_bank_account_access_identifiers',
            'tenant_id, actor_id and policy_revision MATCH SAFE_REFERENCE_128'),
          constraint('ck_bank_account_access_classification',
            `max_classification IN (${ACCOUNT_CLASSIFICATIONS.join(',')})`),
          constraint('ck_bank_account_access_effective_period',
            'effective_to is NULL or after effective_from')
        ]
      },
      {
        name: AUDIT_TABLE,
        columns: [
          column('tenant_id', 'varchar', { length: 128 }),
          column('event_id', 'uuid'),
          column('bank_account_id', 'uuid', { nullable: true }),
          column('actor_server_id', 'varchar', { length: 128 }),
          column('operation', 'varchar', { length: 32 }),
          column('result_code', 'varchar', { length: 64 }),
          column('before_version', 'integer', { nullable: true }),
          column('after_version', 'integer', { nullable: true }),
          column('occurred_at', 'timestamptz')
        ],
        primaryKey: ['tenant_id', 'event_id'],
        constraints: [
          constraint('ck_bank_account_audit_identifiers',
            'tenant_id and actor_server_id MATCH SAFE_REFERENCE_128'),
          constraint('ck_bank_account_audit_operation',
            'operation IN (created,updated,status_changed,access_rebuilt)'),
          constraint('ck_bank_account_audit_result',
            'result_code IN (accepted,rejected,conflict,unavailable)'),
          constraint('ck_bank_account_audit_versions',
            'versions are NULL or 1..1000000 and at least one version is present')
        ]
      }
    ],
    indexes: expectedIndexes(),
    views: [],
    triggers: [],
    routines: [],
    extensions: [],
    grants: []
  };
}

function statements(schemaName) {
  const versions = qualified(schemaName, VERSION_TABLE);
  const relations = qualified(schemaName, RELATION_TABLE);
  const revisions = qualified(schemaName, REVISION_TABLE);
  const access = qualified(schemaName, ACCESS_TABLE);
  const audit = qualified(schemaName, AUDIT_TABLE);
  return [
    `CREATE TABLE ${versions} (
  tenant_id VARCHAR(128) NOT NULL,
  bank_account_id UUID NOT NULL,
  record_version INTEGER NOT NULL,
  holder_entity_id VARCHAR(128) NOT NULL,
  holder_entity_source_revision VARCHAR(128) NOT NULL,
  financial_institution_id VARCHAR(128) NOT NULL,
  financial_institution_source_revision VARCHAR(128) NOT NULL,
  business_owner_agent_id VARCHAR(128) NULL,
  business_owner_agent_source_revision VARCHAR(128) NULL,
  internal_label VARCHAR(120) NOT NULL,
  internal_label_order VARCHAR(120) COLLATE "C" NOT NULL,
  account_type VARCHAR(32) NOT NULL,
  currency CHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL,
  visible BOOLEAN NOT NULL,
  masked_identifier VARCHAR(34) NOT NULL,
  classification CHAR(2) NOT NULL,
  effective_from DATE NULL,
  effective_to DATE NULL,
  source_revision VARCHAR(128) NOT NULL,
  verified_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL,
  replaced_at TIMESTAMPTZ NULL,
  CONSTRAINT pk_bank_account_versions PRIMARY KEY (
    tenant_id, bank_account_id, record_version
  ),
  CONSTRAINT ck_bank_account_versions_tenant CHECK (
    tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ck_bank_account_versions_record_version CHECK (
    record_version BETWEEN 1 AND 1000000
  ),
  CONSTRAINT ck_bank_account_versions_references CHECK (
    holder_entity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND holder_entity_source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND financial_institution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND financial_institution_source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ck_bank_account_versions_optional_owner CHECK (
    (business_owner_agent_id IS NULL AND business_owner_agent_source_revision IS NULL)
    OR (
      business_owner_agent_id IS NOT NULL
      AND business_owner_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND business_owner_agent_source_revision IS NOT NULL
      AND business_owner_agent_source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )
  ),
  CONSTRAINT ck_bank_account_versions_labels CHECK (
    ${displayTextSql('internal_label')}
    AND (internal_label_order COLLATE "C") = (internal_label COLLATE "C")
  ),
  CONSTRAINT ck_bank_account_versions_account_type CHECK (
    account_type IN (${sqlList(ACCOUNT_TYPES)})
  ),
  CONSTRAINT ck_bank_account_versions_currency CHECK (
    currency IN (${sqlList(ISO_4217_CODES)})
  ),
  CONSTRAINT ck_bank_account_versions_status CHECK (
    status IN (${sqlList(ACCOUNT_STATUSES)})
  ),
  CONSTRAINT ck_bank_account_versions_verification CHECK (
    (status IN ('candidate', 'verification_pending') AND verified_at IS NULL)
    OR (status IN ('active', 'suspended', 'closed') AND verified_at IS NOT NULL)
  ),
  CONSTRAINT ck_bank_account_versions_mask CHECK (
    char_length(masked_identifier) BETWEEN 8 AND 34
    AND masked_identifier ~ '^\\*{4,34}[A-Za-z0-9]{0,4}$'
  ),
  CONSTRAINT ck_bank_account_versions_classification CHECK (
    classification IN (${sqlList(ACCOUNT_CLASSIFICATIONS)})
  ),
  CONSTRAINT ck_bank_account_versions_source_revision CHECK (
    source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ck_bank_account_versions_effective_period CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT ck_bank_account_versions_replacement CHECK (
    replaced_at IS NULL OR replaced_at > created_at
  )
)`,
    `CREATE TABLE ${relations} (
  tenant_id VARCHAR(128) NOT NULL,
  relation_kind VARCHAR(32) NOT NULL,
  reference_id VARCHAR(128) NOT NULL,
  source_revision VARCHAR(128) NOT NULL,
  label_snapshot VARCHAR(120) NOT NULL,
  active BOOLEAN NOT NULL,
  visible BOOLEAN NOT NULL,
  classification CHAR(2) NOT NULL,
  effective_from DATE NULL,
  effective_to DATE NULL,
  country_id VARCHAR(128) NULL,
  institution_type VARCHAR(40) NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_bank_account_relation_snapshots PRIMARY KEY (
    tenant_id, relation_kind, reference_id, source_revision
  ),
  CONSTRAINT ck_bank_account_relations_tenant CHECK (
    tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ck_bank_account_relations_kind CHECK (
    relation_kind IN ('holder_entity', 'financial_institution', 'business_owner_agent')
  ),
  CONSTRAINT ck_bank_account_relations_reference CHECK (
    reference_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ck_bank_account_relations_label CHECK (
    ${displayTextSql('label_snapshot')}
  ),
  CONSTRAINT ck_bank_account_relations_classification CHECK (
    classification IN (${sqlList(ACCOUNT_CLASSIFICATIONS)})
  ),
  CONSTRAINT ck_bank_account_relations_effective_period CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT ck_bank_account_relations_institution_fields CHECK (
    (
      relation_kind = 'financial_institution'
      AND country_id IS NOT NULL
      AND country_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND institution_type IN (${sqlList(INSTITUTION_TYPES)})
    ) OR (
      relation_kind <> 'financial_institution'
      AND country_id IS NULL AND institution_type IS NULL
    )
  )
)`,
    `CREATE TABLE ${revisions} (
  tenant_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  contract_version VARCHAR(64) NOT NULL,
  data_classification VARCHAR(64) NOT NULL,
  environment_class VARCHAR(64) NOT NULL,
  schema_fingerprint CHAR(64) NOT NULL,
  source_revision VARCHAR(128) NOT NULL,
  list_revision VARCHAR(128) NOT NULL,
  policy_revision VARCHAR(128) NOT NULL,
  generation BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_bank_account_registry_revisions PRIMARY KEY (tenant_id),
  CONSTRAINT ck_bank_account_revisions_identifiers CHECK (
    tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND contract_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    AND data_classification ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND environment_class ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND list_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ck_bank_account_revisions_fingerprint CHECK (
    schema_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_bank_account_revisions_generation CHECK (generation >= 1)
)`,
    `CREATE TABLE ${access} (
  tenant_id VARCHAR(128) NOT NULL,
  actor_id VARCHAR(128) NOT NULL,
  bank_account_id UUID NOT NULL,
  policy_revision VARCHAR(128) NOT NULL,
  max_classification CHAR(2) NOT NULL,
  active BOOLEAN NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_bank_account_access_projections PRIMARY KEY (
    tenant_id, actor_id, bank_account_id, policy_revision
  ),
  CONSTRAINT ck_bank_account_access_identifiers CHECK (
    tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ck_bank_account_access_classification CHECK (
    max_classification IN (${sqlList(ACCOUNT_CLASSIFICATIONS)})
  ),
  CONSTRAINT ck_bank_account_access_effective_period CHECK (
    effective_to IS NULL OR effective_to > effective_from
  )
)`,
    `CREATE TABLE ${audit} (
  tenant_id VARCHAR(128) NOT NULL,
  event_id UUID NOT NULL,
  bank_account_id UUID NULL,
  actor_server_id VARCHAR(128) NOT NULL,
  operation VARCHAR(32) NOT NULL,
  result_code VARCHAR(64) NOT NULL,
  before_version INTEGER NULL,
  after_version INTEGER NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_bank_account_audit_events PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT ck_bank_account_audit_identifiers CHECK (
    tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND actor_server_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ck_bank_account_audit_operation CHECK (
    operation IN ('created', 'updated', 'status_changed', 'access_rebuilt')
  ),
  CONSTRAINT ck_bank_account_audit_result CHECK (
    result_code IN ('accepted', 'rejected', 'conflict', 'unavailable')
  ),
  CONSTRAINT ck_bank_account_audit_versions CHECK (
    (before_version IS NULL OR before_version BETWEEN 1 AND 1000000)
    AND (after_version IS NULL OR after_version BETWEEN 1 AND 1000000)
    AND (before_version IS NOT NULL OR after_version IS NOT NULL)
  )
)`,
    `CREATE UNIQUE INDEX ${quoted(INDEX_NAMES.current)} ON ${versions} (
  tenant_id, bank_account_id
) WHERE replaced_at IS NULL`,
    `CREATE INDEX ${quoted(INDEX_NAMES.list)} ON ${versions} (
  tenant_id, internal_label_order COLLATE "C", bank_account_id
) WHERE replaced_at IS NULL AND status = 'active' AND visible IS TRUE`,
    `CREATE INDEX ${quoted(INDEX_NAMES.filters)} ON ${versions} (
  tenant_id, status, classification, account_type, currency,
  holder_entity_id, financial_institution_id,
  internal_label_order COLLATE "C", bank_account_id
) WHERE replaced_at IS NULL AND status = 'active' AND visible IS TRUE`,
    `CREATE INDEX ${quoted(INDEX_NAMES.access)} ON ${access} (
  tenant_id, actor_id, policy_revision, bank_account_id
) WHERE active IS TRUE`,
    `CREATE INDEX ${quoted(INDEX_NAMES.audit)} ON ${audit} (
  tenant_id, bank_account_id, occurred_at DESC, event_id
)`
  ];
}

function queries(schemaName) {
  const versions = qualified(schemaName, VERSION_TABLE);
  const relations = qualified(schemaName, RELATION_TABLE);
  const revisions = qualified(schemaName, REVISION_TABLE);
  const access = qualified(schemaName, ACCESS_TABLE);
  const audit = qualified(schemaName, AUDIT_TABLE);
  const readableRelation = (alias, kind, idColumn, revisionColumn) => `EXISTS (
    SELECT 1 FROM ${relations} AS ${alias}
    WHERE ${alias}.tenant_id = a.tenant_id
      AND ${alias}.relation_kind = '${kind}'
      AND ${alias}.reference_id = a.${idColumn}
      AND ${alias}.source_revision = a.${revisionColumn}
      AND ${alias}.active IS TRUE
      AND ${alias}.visible IS TRUE
      AND (a.classification = 'C3' OR ${alias}.classification = 'C2')
      AND (${alias}.effective_from IS NULL OR ${alias}.effective_from <=
        (($3::timestamptz AT TIME ZONE 'UTC')::date))
      AND (${alias}.effective_to IS NULL OR ${alias}.effective_to >=
        (($3::timestamptz AT TIME ZONE 'UTC')::date))
  )`;
  const holderReadable = readableRelation(
    'he', 'holder_entity', 'holder_entity_id', 'holder_entity_source_revision'
  );
  const institutionReadable = readableRelation(
    'fi', 'financial_institution',
    'financial_institution_id', 'financial_institution_source_revision'
  );
  const ownerReadable = readableRelation(
    'ag', 'business_owner_agent',
    'business_owner_agent_id', 'business_owner_agent_source_revision'
  );
  const authorizedFilters = `a.tenant_id = $1
  AND p.tenant_id = $1
  AND p.actor_id = $2
  AND p.policy_revision = $4
  AND p.bank_account_id = a.bank_account_id
  AND p.active IS TRUE
  AND p.effective_from <= $3
  AND (p.effective_to IS NULL OR p.effective_to > $3)
  AND (a.classification = 'C2' OR p.max_classification = 'C3')
  AND a.replaced_at IS NULL
  AND a.status = 'active'
  AND a.visible IS TRUE
  AND (a.effective_from IS NULL OR a.effective_from <=
    (($3::timestamptz AT TIME ZONE 'UTC')::date))
  AND (a.effective_to IS NULL OR a.effective_to >=
    (($3::timestamptz AT TIME ZONE 'UTC')::date))
  AND ${holderReadable}
  AND ${institutionReadable}
  AND (a.business_owner_agent_id IS NULL OR ${ownerReadable})
  AND ($5::varchar IS NULL OR a.holder_entity_id = $5)
  AND ($6::varchar IS NULL OR a.financial_institution_id = $6)
  AND ($7::varchar IS NULL OR a.account_type = $7)
  AND ($8::char(3) IS NULL OR a.currency = $8)
  AND ($9::varchar IS NULL OR a.status = $9)
  AND ($10::char(2) IS NULL OR a.classification = $10)`;
  return [
    {
      code: 'Q-01',
      name: 'account-exact-read',
      mode: 'read-only',
      parameterCount: 3,
      maxRows: 2,
      text: `SELECT
  a.bank_account_id,
  a.tenant_id,
  a.holder_entity_id,
  he.label_snapshot AS holder_entity_label_snapshot,
  a.holder_entity_source_revision,
  a.financial_institution_id,
  fi.label_snapshot AS financial_institution_label_snapshot,
  fi.country_id AS financial_institution_country_id,
  fi.institution_type AS financial_institution_type,
  a.financial_institution_source_revision,
  a.internal_label,
  a.account_type,
  a.currency,
  a.status,
  a.visible,
  a.masked_identifier,
  a.classification,
  a.business_owner_agent_id,
  ag.label_snapshot AS business_owner_agent_label_snapshot,
  a.business_owner_agent_source_revision,
  a.effective_from,
  a.effective_to,
  a.source_revision,
  a.verified_at,
  a.record_version
FROM ${versions} AS a
JOIN ${relations} AS he ON
  he.tenant_id = a.tenant_id
  AND he.relation_kind = 'holder_entity'
  AND he.reference_id = a.holder_entity_id
  AND he.source_revision = a.holder_entity_source_revision
JOIN ${relations} AS fi ON
  fi.tenant_id = a.tenant_id
  AND fi.relation_kind = 'financial_institution'
  AND fi.reference_id = a.financial_institution_id
  AND fi.source_revision = a.financial_institution_source_revision
LEFT JOIN ${relations} AS ag ON
  ag.tenant_id = a.tenant_id
  AND ag.relation_kind = 'business_owner_agent'
  AND ag.reference_id = a.business_owner_agent_id
  AND ag.source_revision = a.business_owner_agent_source_revision
WHERE a.tenant_id = $1
  AND a.bank_account_id = $2
  AND a.replaced_at IS NULL
  AND (a.effective_from IS NULL OR a.effective_from <=
    (($3::timestamptz AT TIME ZONE 'UTC')::date))
  AND (a.effective_to IS NULL OR a.effective_to >=
    (($3::timestamptz AT TIME ZONE 'UTC')::date))
LIMIT 2`
    },
    {
      code: 'Q-02',
      name: 'relation-exact-read',
      mode: 'read-only',
      parameterCount: 5,
      maxRows: 2,
      text: `SELECT
  reference_id,
  tenant_id,
  label_snapshot,
  source_revision,
  active,
  visible,
  classification,
  effective_from,
  effective_to,
  country_id,
  institution_type
FROM ${relations}
WHERE tenant_id = $1
  AND relation_kind = $2
  AND reference_id = $3
  AND source_revision = $4
  AND (effective_from IS NULL OR effective_from <=
    (($5::timestamptz AT TIME ZONE 'UTC')::date))
  AND (effective_to IS NULL OR effective_to >=
    (($5::timestamptz AT TIME ZONE 'UTC')::date))
LIMIT 2`
    },
    {
      code: 'Q-03',
      name: 'authorized-handle-list',
      mode: 'read-only',
      parameterCount: 15,
      maxRows: 51,
      text: `SELECT
  a.bank_account_id,
  a.internal_label_order,
  a.source_revision
FROM ${versions} AS a
JOIN ${access} AS p ON p.bank_account_id = a.bank_account_id
JOIN ${revisions} AS r ON r.tenant_id = a.tenant_id
WHERE ${authorizedFilters}
  AND r.list_revision = $13
  AND r.source_revision = $14
  AND r.policy_revision = p.policy_revision
  AND (
    $11::varchar IS NULL
    OR (a.internal_label_order COLLATE "C", a.bank_account_id) >
       ($11 COLLATE "C", $12::uuid)
  )
ORDER BY a.internal_label_order COLLATE "C" ASC, a.bank_account_id ASC
LIMIT $15`
    },
    {
      code: 'Q-04',
      name: 'authorized-filtered-total',
      mode: 'read-only',
      parameterCount: 12,
      maxRows: 1,
      text: `SELECT COUNT(*)::integer AS authorized_filtered_count
FROM ${versions} AS a
JOIN ${access} AS p ON p.bank_account_id = a.bank_account_id
JOIN ${revisions} AS r ON r.tenant_id = a.tenant_id
WHERE ${authorizedFilters}
  AND r.list_revision = $11
  AND r.source_revision = $12
  AND r.policy_revision = p.policy_revision`
    },
    {
      code: 'Q-05',
      name: 'registry-revisions-read',
      mode: 'read-only',
      parameterCount: 1,
      maxRows: 1,
      text: `SELECT source_revision, list_revision, policy_revision, generation, updated_at
FROM ${revisions}
WHERE tenant_id = $1
LIMIT 1`
    },
    {
      code: 'Q-06',
      name: 'source-contract-probe',
      mode: 'read-only',
      parameterCount: 1,
      maxRows: 1,
      text: `SELECT
  source_id,
  contract_version,
  data_classification,
  environment_class,
  schema_fingerprint,
  updated_at
FROM ${revisions}
WHERE tenant_id = $1
LIMIT 1`
    },
    {
      code: 'Q-07',
      name: 'future-minimal-audit-write',
      mode: 'future-write-not-authorized',
      parameterCount: 9,
      maxRows: 1,
      text: `INSERT INTO ${audit} (
  tenant_id, event_id, bank_account_id, actor_server_id, operation,
  result_code, before_version, after_version, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING tenant_id, event_id`
    }
  ];
}

function assertSchemaName(schemaName) {
  if (schemaName !== SCHEMA_NAME) fail();
}

function schemaNameFromOptions(options) {
  if (options === undefined) return SCHEMA_NAME;
  if (!isPlainData(options)) fail();
  const keys = Object.keys(options);
  if (keys.length !== 1 || keys[0] !== 'schemaName'
    || typeof options.schemaName !== 'string') fail();
  return options.schemaName;
}

function buildBankAccountPostgresOfflinePlan(options) {
  const schemaName = schemaNameFromOptions(options);
  assertSchemaName(schemaName);
  const unsignedPlan = {
    contractId: CONTRACT_ID,
    planVersion: PLAN_VERSION,
    engine: 'postgresql',
    schemaName,
    databaseEncoding: 'UTF8',
    requiresExistingSchema: true,
    transactionIsolation: 'REPEATABLE READ',
    applyMode: 'offline-only',
    dataClass: 'MASKED_ORGANIZATIONAL_METADATA_ONLY',
    statements: statements(schemaName),
    queries: queries(schemaName),
    expectedCatalog: expectedCatalog(schemaName),
    forbiddenColumnNames: [...FORBIDDEN_COLUMN_NAMES]
  };
  return deepFreeze({ ...unsignedPlan, fingerprint: fingerprint(unsignedPlan) });
}

function validateBankAccountPostgresOfflinePlan(plan) {
  const expected = buildBankAccountPostgresOfflinePlan();
  if (canonical(plan) !== canonical(expected)) fail();
  return deepFreeze({ valid: true, fingerprint: expected.fingerprint });
}

function validateBankAccountPostgresInspection(plan, inspection) {
  const validation = validateBankAccountPostgresOfflinePlan(plan);
  if (!isPlainData(inspection)) fail();
  const fields = { ...inspection };
  if (!Number.isInteger(fields.postgresMajor)
    || fields.postgresMajor < MIN_POSTGRES_MAJOR
    || fields.postgresMajor > MAX_POSTGRES_MAJOR) fail();
  const postgresMajor = fields.postgresMajor;
  delete fields.postgresMajor;
  if (canonical(fields) !== canonical(plan.expectedCatalog)) fail();
  return deepFreeze({ valid: true, fingerprint: validation.fingerprint, postgresMajor });
}

module.exports = {
  ACCESS_TABLE,
  AUDIT_TABLE,
  BankAccountPostgresSchemaError,
  CONTRACT_ID,
  FORBIDDEN_COLUMN_NAMES,
  INDEX_NAMES,
  MAX_POSTGRES_MAJOR,
  MIN_POSTGRES_MAJOR,
  PLAN_VERSION,
  RELATION_TABLE,
  REVISION_TABLE,
  SCHEMA_NAME,
  VERSION_TABLE,
  buildBankAccountPostgresOfflinePlan,
  validateBankAccountPostgresInspection,
  validateBankAccountPostgresOfflinePlan
};

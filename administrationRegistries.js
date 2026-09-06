const crypto = require('crypto');
const { assertBigQueryTableContract } = require('./bigQueryTableContract');

const field = (name, type = 'STRING', mode = 'REQUIRED') => ({ name, type, mode });
const ADMINISTRATION_TABLE_CONTRACTS = Object.freeze({
  administration_resources: {
    fields: [
      field('id'), field('tenant_id'), field('title'), field('family'), field('authority'),
      field('location'), field('source_status'), field('review_status'), field('confidentiality'),
      field('note', 'STRING', 'NULLABLE'), field('created_by_user_id'),
      field('created_by_name', 'STRING', 'NULLABLE'), field('created_at', 'TIMESTAMP'),
      field('updated_by_user_id'), field('updated_at', 'TIMESTAMP'),
      field('deleted_at', 'TIMESTAMP', 'NULLABLE')
    ],
    partitionField: 'created_at',
    clustering: ['tenant_id', 'confidentiality', 'family']
  },
  administration_correspondence: {
    fields: [
      field('id'), field('tenant_id'), field('receipt_date', 'DATE'), field('direction'),
      field('channel'), field('sender'), field('recipient'), field('subject'), field('category'),
      field('confidentiality'), field('linked_person_or_case', 'STRING', 'NULLABLE'),
      field('ged_reference', 'STRING', 'NULLABLE'),
      field('receipt_evidence_reference', 'STRING', 'NULLABLE'), field('owner'),
      field('next_action', 'STRING', 'NULLABLE'), field('status'),
      field('deadline', 'DATE', 'NULLABLE'), field('created_by_user_id'),
      field('created_by_name', 'STRING', 'NULLABLE'), field('created_at', 'TIMESTAMP'),
      field('updated_by_user_id'), field('updated_at', 'TIMESTAMP'),
      field('deleted_at', 'TIMESTAMP', 'NULLABLE')
    ],
    partitionField: 'receipt_date',
    clustering: ['tenant_id', 'confidentiality', 'status']
  },
  administration_audit_log: {
    fields: [
      field('id'), field('tenant_id'), field('actor_user_id'),
      field('actor_name', 'STRING', 'NULLABLE'), field('entity_type'), field('entity_id'),
      field('action'), field('event_at', 'TIMESTAMP'), field('metadata_json', 'STRING', 'NULLABLE')
    ],
    partitionField: 'event_at',
    clustering: ['tenant_id', 'entity_type', 'action']
  }
});

const PERMISSIONS = Object.freeze({
  RESOURCES_READ: 'administration:resources:read',
  RESOURCES_WRITE: 'administration:resources:write',
  RESOURCES_RESTRICTED: 'administration:resources:restricted',
  CORRESPONDENCE_READ: 'administration:correspondence:read',
  CORRESPONDENCE_WRITE: 'administration:correspondence:write',
  CORRESPONDENCE_RESTRICTED: 'administration:correspondence:restricted',
  AUDIT_READ: 'administration:audit:read'
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
const RESOURCE_ENUMS = Object.freeze({
  family: new Set(['legal_regulatory', 'institution_governance', 'processes_methods', 'planning_projects']),
  source_status: new Set(['official', 'governed_internal', 'to_qualify']),
  review_status: new Set(['controlled', 'to_review', 'to_complete']),
  confidentiality: new Set(['public', 'internal', 'restricted'])
});
const CORRESPONDENCE_ENUMS = Object.freeze({
  direction: new Set(['incoming', 'outgoing', 'internal']),
  channel: new Set(['whatsapp', 'email', 'paper', 'form', 'hand_delivery']),
  category: new Set(['human_resources', 'institutional', 'supplier', 'legal', 'project']),
  confidentiality: new Set(['public', 'internal', 'restricted_hr', 'confidential']),
  status: new Set(['to_qualify', 'to_file_dms', 'in_progress', 'closed'])
});
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'file', 'files', 'content', 'file_content', 'attachment', 'attachments',
  'base64', 'blob', 'cv', 'resume', 'document_binary'
]);
const RESOURCE_FIELDS = new Set([
  'title', 'family', 'authority', 'location', 'source_status', 'review_status',
  'confidentiality', 'note'
]);
const CORRESPONDENCE_FIELDS = new Set([
  'receipt_date', 'direction', 'channel', 'sender', 'recipient', 'subject',
  'category', 'confidentiality', 'linked_person_or_case', 'ged_reference',
  'receipt_evidence_reference', 'owner', 'next_action', 'status', 'deadline'
]);

const validateSchemaIdentifier = (value, label, pattern) => {
  const identifier = String(value || '').trim();
  if (!pattern.test(identifier)) {
    throw new Error(`Invalid BigQuery ${label}`);
  }
  return identifier;
};

const buildAdministrationRegistrySchemaStatements = ({ projectId, datasetId }) => {
  const project = validateSchemaIdentifier(projectId, 'project identifier', /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  const dataset = validateSchemaIdentifier(datasetId, 'dataset identifier', /^[A-Za-z_][A-Za-z0-9_]*$/);
  const table = name => `\`${project}.${dataset}.${name}\``;

  return [
    `CREATE TABLE IF NOT EXISTS ${table('administration_resources')} (
      id STRING NOT NULL,
      tenant_id STRING NOT NULL,
      title STRING NOT NULL,
      family STRING NOT NULL,
      authority STRING NOT NULL,
      location STRING NOT NULL,
      source_status STRING NOT NULL,
      review_status STRING NOT NULL,
      confidentiality STRING NOT NULL,
      note STRING,
      created_by_user_id STRING NOT NULL,
      created_by_name STRING,
      created_at TIMESTAMP NOT NULL,
      updated_by_user_id STRING NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      deleted_at TIMESTAMP
    )
    PARTITION BY DATE(created_at)
    CLUSTER BY tenant_id, confidentiality, family`,
    `CREATE TABLE IF NOT EXISTS ${table('administration_correspondence')} (
      id STRING NOT NULL,
      tenant_id STRING NOT NULL,
      receipt_date DATE NOT NULL,
      direction STRING NOT NULL,
      channel STRING NOT NULL,
      sender STRING NOT NULL,
      recipient STRING NOT NULL,
      subject STRING NOT NULL,
      category STRING NOT NULL,
      confidentiality STRING NOT NULL,
      linked_person_or_case STRING,
      ged_reference STRING,
      receipt_evidence_reference STRING,
      owner STRING NOT NULL,
      next_action STRING,
      status STRING NOT NULL,
      deadline DATE,
      created_by_user_id STRING NOT NULL,
      created_by_name STRING,
      created_at TIMESTAMP NOT NULL,
      updated_by_user_id STRING NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      deleted_at TIMESTAMP
    )
    PARTITION BY receipt_date
    CLUSTER BY tenant_id, confidentiality, status`,
    `CREATE TABLE IF NOT EXISTS ${table('administration_audit_log')} (
      id STRING NOT NULL,
      tenant_id STRING NOT NULL,
      actor_user_id STRING NOT NULL,
      actor_name STRING,
      entity_type STRING NOT NULL,
      entity_id STRING NOT NULL,
      action STRING NOT NULL,
      event_at TIMESTAMP NOT NULL,
      metadata_json STRING
    )
    PARTITION BY DATE(event_at)
    CLUSTER BY tenant_id, entity_type, action`
  ];
};

const ensureAdministrationRegistrySchema = async ({
  bigquery,
  projectId,
  datasetId,
  location = 'US'
}) => {
  const statements = buildAdministrationRegistrySchemaStatements({ projectId, datasetId });
  for (const query of statements) {
    await bigquery.query({ query, location });
  }
  const dataset = bigquery.dataset(datasetId);
  for (const [tableId, contract] of Object.entries(ADMINISTRATION_TABLE_CONTRACTS)) {
    await assertBigQueryTableContract(dataset.table(tableId), contract, 'ADMINISTRATION_SCHEMA_INVALID');
  }
  return {
    tables: [
      'administration_resources',
      'administration_correspondence',
      'administration_audit_log'
    ]
  };
};

class RegistryValidationError extends Error {
  constructor(message, code = 'ADMIN_REGISTRY_INVALID_PAYLOAD') {
    super(message);
    this.code = code;
  }
}

const normalizeRole = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const defaultPermissionsForRole = role => {
  const normalized = normalizeRole(role);
  if (['fondateur', 'membre fondateur', 'manager'].includes(normalized)) return [...ALL_PERMISSIONS];
  if (['administrateur', 'administrator', 'responsable administration'].includes(normalized)) {
    return [
      PERMISSIONS.RESOURCES_READ,
      PERMISSIONS.RESOURCES_WRITE,
      PERMISSIONS.CORRESPONDENCE_READ,
      PERMISSIONS.CORRESPONDENCE_WRITE
    ];
  }
  if (['organisation & rh', 'organisation et rh', 'ressources humaines', 'human resources', 'hr'].includes(normalized)) {
    return [
      PERMISSIONS.RESOURCES_READ,
      PERMISSIONS.CORRESPONDENCE_READ,
      PERMISSIONS.CORRESPONDENCE_WRITE,
      PERMISSIONS.CORRESPONDENCE_RESTRICTED
    ];
  }
  return [PERMISSIONS.RESOURCES_READ, PERMISSIONS.CORRESPONDENCE_READ];
};

const permissionsForAccount = account => {
  if (Array.isArray(account?.permissions)) {
    return [...new Set(account.permissions.filter(permission => ALL_PERMISSIONS.includes(permission)))];
  }
  return defaultPermissionsForRole(account?.role);
};

const userIdentity = user => ({
  tenantId: String(user?.tenantId || user?.organizationId || '').trim(),
  userId: String(user?.id || user?.email || '').trim(),
  name: String(user?.name || user?.email || '').trim(),
  permissions: new Set(
    Array.isArray(user?.permissions)
      ? user.permissions.filter(permission => ALL_PERMISSIONS.includes(permission))
      : defaultPermissionsForRole(user?.role)
  )
});

const parsePagination = query => {
  const requestedLimit = Number.parseInt(query?.limit, 10);
  const requestedOffset = Number.parseInt(query?.offset, 10);
  return {
    limit: Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100,
    offset: Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0
  };
};

const parseAuditMetadata = value => {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    const changedFields = Array.isArray(parsed?.changed_fields)
      ? parsed.changed_fields
        .filter(field => typeof field === 'string')
        .map(field => field.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 80)
      : [];
    return { changed_fields: changedFields };
  } catch {
    return { changed_fields: [] };
  }
};

const assertNoFilePayload = (value, path = 'root') => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFilePayload(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
      throw new RegistryValidationError(`File or document content is forbidden at ${path}.${key}`, 'ADMIN_REGISTRY_FILE_CONTENT_FORBIDDEN');
    }
    assertNoFilePayload(item, `${path}.${key}`);
  });
};

const assertOnlyFields = (body, allowedFields) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RegistryValidationError('Payload must be an object');
  }
  const unexpected = Object.keys(body).filter(key => !allowedFields.has(key));
  if (unexpected.length) {
    throw new RegistryValidationError(`Unexpected fields: ${unexpected.join(', ')}`);
  }
};

const cleanString = (value, field, { required = false, max = 500 } = {}) => {
  const cleaned = String(value ?? '').trim();
  if (required && !cleaned) throw new RegistryValidationError(`${field} is required`);
  if (cleaned.length > max) throw new RegistryValidationError(`${field} exceeds ${max} characters`);
  return cleaned;
};

const cleanEnum = (value, field, allowed, fallback) => {
  const cleaned = cleanString(value || fallback, field, { required: true, max: 80 });
  if (!allowed.has(cleaned)) throw new RegistryValidationError(`Invalid ${field}`);
  return cleaned;
};

const cleanDate = (value, field, required = false) => {
  const cleaned = cleanString(value, field, { required, max: 10 });
  if (!cleaned) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (!match) throw new RegistryValidationError(`Invalid ${field}`);
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RegistryValidationError(`Invalid ${field}`);
  }
  return cleaned;
};

const normalizeResourcePayload = body => {
  assertNoFilePayload(body);
  assertOnlyFields(body, RESOURCE_FIELDS);
  return {
    title: cleanString(body?.title, 'title', { required: true, max: 240 }),
    family: cleanEnum(body?.family, 'family', RESOURCE_ENUMS.family, 'institution_governance'),
    authority: cleanString(body?.authority, 'authority', { required: true, max: 240 }),
    location: cleanString(body?.location, 'location', { required: true, max: 800 }),
    source_status: cleanEnum(body?.source_status, 'source_status', RESOURCE_ENUMS.source_status, 'to_qualify'),
    review_status: cleanEnum(body?.review_status, 'review_status', RESOURCE_ENUMS.review_status, 'to_complete'),
    confidentiality: cleanEnum(body?.confidentiality, 'confidentiality', RESOURCE_ENUMS.confidentiality, 'internal'),
    note: cleanString(body?.note, 'note', { max: 2000 })
  };
};

const normalizeCorrespondencePayload = body => {
  assertNoFilePayload(body);
  assertOnlyFields(body, CORRESPONDENCE_FIELDS);
  return {
    receipt_date: cleanDate(body?.receipt_date, 'receipt_date', true),
    direction: cleanEnum(body?.direction, 'direction', CORRESPONDENCE_ENUMS.direction, 'incoming'),
    channel: cleanEnum(body?.channel, 'channel', CORRESPONDENCE_ENUMS.channel, 'email'),
    sender: cleanString(body?.sender, 'sender', { required: true, max: 240 }),
    recipient: cleanString(body?.recipient, 'recipient', { required: true, max: 240 }),
    subject: cleanString(body?.subject, 'subject', { required: true, max: 500 }),
    category: cleanEnum(body?.category, 'category', CORRESPONDENCE_ENUMS.category, 'institutional'),
    confidentiality: cleanEnum(body?.confidentiality, 'confidentiality', CORRESPONDENCE_ENUMS.confidentiality, 'internal'),
    linked_person_or_case: cleanString(body?.linked_person_or_case, 'linked_person_or_case', { max: 240 }),
    ged_reference: cleanString(body?.ged_reference, 'ged_reference', { max: 500 }),
    receipt_evidence_reference: cleanString(body?.receipt_evidence_reference, 'receipt_evidence_reference', { max: 500 }),
    owner: cleanString(body?.owner, 'owner', { required: true, max: 240 }),
    next_action: cleanString(body?.next_action, 'next_action', { max: 2000 }),
    status: cleanEnum(body?.status, 'status', CORRESPONDENCE_ENUMS.status, 'to_qualify'),
    deadline: cleanDate(body?.deadline, 'deadline')
  };
};

const isMissingTable = error => {
  const message = String(error?.message || '');
  return message.includes('Not found: Table') || message.includes('Not found: Dataset');
};

const respondError = (res, error, logger) => {
  if (error instanceof RegistryValidationError) {
    return res.status(400).json({ success: false, code: error.code, error: error.message });
  }
  if (isMissingTable(error)) {
    return res.status(503).json({
      success: false,
      code: 'ADMIN_REGISTRY_SOURCE_UNAVAILABLE',
      error: 'Administration registry source unavailable'
    });
  }
  logger.error('Administration registry error:', error.message);
  return res.status(500).json({ success: false, code: 'ADMIN_REGISTRY_ERROR', error: 'Administration registry error' });
};

const authorize = (req, res, permission) => {
  const identity = userIdentity(req.user);
  if (!req.user || !identity.tenantId || !identity.userId) {
    res.status(401).json({ success: false, code: 'ADMIN_REGISTRY_UNAUTHENTICATED', error: 'Authentication required' });
    return null;
  }
  if (!identity.permissions.has(permission)) {
    res.status(403).json({ success: false, code: 'ADMIN_REGISTRY_FORBIDDEN', error: 'Access denied' });
    return null;
  }
  return identity;
};

const createAdministrationRegistryHandlers = ({
  bigquery,
  projectId,
  datasetId,
  location = 'US',
  now = () => new Date().toISOString(),
  idGenerator = prefix => `${prefix}-${crypto.randomUUID()}`,
  logger = console
}) => {
  const resourcesTable = `\`${projectId}.${datasetId}.administration_resources\``;
  const correspondenceTable = `\`${projectId}.${datasetId}.administration_correspondence\``;
  const auditTable = `\`${projectId}.${datasetId}.administration_audit_log\``;
  const run = (query, params) => bigquery.query({ query, params, location });
  const commonParams = identity => ({
    tenant_id: identity.tenantId,
    user_id: identity.userId,
    user_name: identity.name,
    can_read_restricted_resources: identity.permissions.has(PERMISSIONS.RESOURCES_RESTRICTED),
    can_read_restricted_correspondence: identity.permissions.has(PERMISSIONS.CORRESPONDENCE_RESTRICTED)
  });
  const auditParams = (identity, entityType, entityId, action, changedFields) => ({
    audit_id: idGenerator('AUD'),
    ...commonParams(identity),
    entity_type: entityType,
    entity_id: entityId,
    action,
    event_at: now(),
    metadata_json: JSON.stringify({ changed_fields: changedFields })
  });
  const findVisibleEntity = async ({ table, id, identity, restrictedCondition }) => {
    const [rows] = await run(`
      SELECT id, confidentiality, created_by_user_id
      FROM ${table}
      WHERE tenant_id=@tenant_id AND id=@id AND deleted_at IS NULL
        AND (${restrictedCondition})
      LIMIT 1
    `, { id, ...commonParams(identity) });
    return rows[0] || null;
  };

  const listResources = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.RESOURCES_READ);
    if (!identity) return;
    const { limit, offset } = parsePagination(req.query);
    try {
      const [rows] = await run(`
        SELECT id, title, family, authority, location, source_status, review_status,
          confidentiality, note, created_by_user_id, created_by_name, created_at, updated_at
        FROM ${resourcesTable}
        WHERE tenant_id = @tenant_id AND deleted_at IS NULL
          AND (confidentiality != 'restricted' OR @can_read_restricted_resources OR created_by_user_id = @user_id)
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `, commonParams(identity));
      return res.json({ success: true, data: rows, count: rows.length, limit, offset, source: 'bigquery', timestamp: now() });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  const createResource = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.RESOURCES_WRITE);
    if (!identity) return;
    try {
      const payload = normalizeResourcePayload(req.body);
      if (payload.confidentiality === 'restricted' && !identity.permissions.has(PERMISSIONS.RESOURCES_RESTRICTED)) {
        return res.status(403).json({ success: false, code: 'ADMIN_REGISTRY_RESTRICTED_FORBIDDEN', error: 'Restricted resource permission required' });
      }
      const id = idGenerator('RES');
      const params = { id, ...payload, ...commonParams(identity), created_at: now(), ...auditParams(identity, 'resource', id, 'create', Object.keys(payload)) };
      const [rows] = await run(`
        BEGIN TRANSACTION;
        INSERT INTO ${resourcesTable}
          (id, tenant_id, title, family, authority, location, source_status, review_status,
           confidentiality, note, created_by_user_id, created_by_name, created_at,
           updated_by_user_id, updated_at, deleted_at)
        VALUES (@id, @tenant_id, @title, @family, @authority, @location, @source_status,
          @review_status, @confidentiality, @note, @user_id, @user_name, TIMESTAMP(@created_at),
          @user_id, TIMESTAMP(@created_at), NULL);
        INSERT INTO ${auditTable}
          (id, tenant_id, actor_user_id, actor_name, entity_type, entity_id, action, event_at, metadata_json)
        VALUES (@audit_id, @tenant_id, @user_id, @user_name, @entity_type, @entity_id,
          @action, TIMESTAMP(@event_at), @metadata_json);
        COMMIT TRANSACTION;
        SELECT id, title, family, authority, location, source_status, review_status,
          confidentiality, note, created_by_user_id, created_by_name, created_at, updated_at
        FROM ${resourcesTable} WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;
      `, params);
      return res.status(201).json({ success: true, data: rows[0], source: 'bigquery' });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  const updateResource = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.RESOURCES_WRITE);
    if (!identity) return;
    try {
      const payload = normalizeResourcePayload(req.body);
      if (payload.confidentiality === 'restricted' && !identity.permissions.has(PERMISSIONS.RESOURCES_RESTRICTED)) {
        return res.status(403).json({ success: false, code: 'ADMIN_REGISTRY_RESTRICTED_FORBIDDEN', error: 'Restricted resource permission required' });
      }
      const id = cleanString(req.params.id, 'id', { required: true, max: 120 });
      const existing = await findVisibleEntity({
        table: resourcesTable,
        id,
        identity,
        restrictedCondition: "confidentiality != 'restricted' OR @can_read_restricted_resources OR created_by_user_id=@user_id"
      });
      if (!existing) return res.status(404).json({ success: false, code: 'ADMIN_REGISTRY_NOT_FOUND', error: 'Resource not found' });
      const params = { id, ...payload, ...commonParams(identity), updated_at: now(), ...auditParams(identity, 'resource', id, 'update', Object.keys(payload)) };
      const [rows] = await run(`
        BEGIN TRANSACTION;
        UPDATE ${resourcesTable}
        SET title=@title, family=@family, authority=@authority, location=@location,
          source_status=@source_status, review_status=@review_status,
          confidentiality=@confidentiality, note=@note, updated_by_user_id=@user_id,
          updated_at=TIMESTAMP(@updated_at)
        WHERE tenant_id=@tenant_id AND id=@id AND deleted_at IS NULL;
        INSERT INTO ${auditTable}
          (id, tenant_id, actor_user_id, actor_name, entity_type, entity_id, action, event_at, metadata_json)
        VALUES (@audit_id, @tenant_id, @user_id, @user_name, @entity_type, @entity_id,
          @action, TIMESTAMP(@event_at), @metadata_json);
        COMMIT TRANSACTION;
        SELECT id, title, family, authority, location, source_status, review_status,
          confidentiality, note, created_by_user_id, created_by_name, created_at, updated_at
        FROM ${resourcesTable} WHERE tenant_id=@tenant_id AND id=@id AND deleted_at IS NULL;
      `, params);
      if (!rows[0]) return res.status(404).json({ success: false, code: 'ADMIN_REGISTRY_NOT_FOUND', error: 'Resource not found' });
      return res.json({ success: true, data: rows[0], source: 'bigquery' });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  const deleteResource = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.RESOURCES_WRITE);
    if (!identity) return;
    try {
      const id = cleanString(req.params.id, 'id', { required: true, max: 120 });
      const existing = await findVisibleEntity({
        table: resourcesTable,
        id,
        identity,
        restrictedCondition: "confidentiality != 'restricted' OR @can_read_restricted_resources OR created_by_user_id=@user_id"
      });
      if (!existing) return res.status(404).json({ success: false, code: 'ADMIN_REGISTRY_NOT_FOUND', error: 'Resource not found' });
      const params = { id, ...commonParams(identity), deleted_at: now(), ...auditParams(identity, 'resource', id, 'delete', ['deleted_at']) };
      await run(`
        BEGIN TRANSACTION;
        UPDATE ${resourcesTable}
        SET deleted_at=TIMESTAMP(@deleted_at), updated_by_user_id=@user_id, updated_at=TIMESTAMP(@deleted_at)
        WHERE tenant_id=@tenant_id AND id=@id AND deleted_at IS NULL;
        INSERT INTO ${auditTable}
          (id, tenant_id, actor_user_id, actor_name, entity_type, entity_id, action, event_at, metadata_json)
        VALUES (@audit_id, @tenant_id, @user_id, @user_name, @entity_type, @entity_id,
          @action, TIMESTAMP(@event_at), @metadata_json);
        COMMIT TRANSACTION;
      `, params);
      return res.json({ success: true, id });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  const listCorrespondence = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.CORRESPONDENCE_READ);
    if (!identity) return;
    const { limit, offset } = parsePagination(req.query);
    try {
      const [rows] = await run(`
        SELECT id, receipt_date, direction, channel, sender, recipient, subject, category,
          confidentiality, linked_person_or_case, ged_reference, receipt_evidence_reference,
          owner, next_action, status, deadline, created_by_user_id, created_by_name,
          created_at, updated_at
        FROM ${correspondenceTable}
        WHERE tenant_id=@tenant_id AND deleted_at IS NULL
          AND (confidentiality NOT IN ('restricted_hr', 'confidential')
            OR @can_read_restricted_correspondence OR created_by_user_id=@user_id)
        ORDER BY receipt_date DESC, updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `, commonParams(identity));
      return res.json({ success: true, data: rows, count: rows.length, limit, offset, source: 'bigquery', timestamp: now() });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  const listAuditEvents = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.AUDIT_READ);
    if (!identity) return;
    const { limit, offset } = parsePagination(req.query);
    try {
      const [rows] = await run(`
        SELECT id, actor_name, entity_type, entity_id, action, event_at, metadata_json
        FROM ${auditTable}
        WHERE tenant_id=@tenant_id
        ORDER BY event_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `, commonParams(identity));
      const data = rows.map(row => ({
        id: row.id,
        actor_name: row.actor_name || '',
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        action: row.action,
        event_at: row.event_at,
        changed_fields: parseAuditMetadata(row.metadata_json).changed_fields
      }));
      return res.json({ success: true, data, count: data.length, limit, offset, source: 'bigquery', timestamp: now() });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  const createCorrespondence = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.CORRESPONDENCE_WRITE);
    if (!identity) return;
    try {
      const payload = normalizeCorrespondencePayload(req.body);
      if (['restricted_hr', 'confidential'].includes(payload.confidentiality)
        && !identity.permissions.has(PERMISSIONS.CORRESPONDENCE_RESTRICTED)) {
        return res.status(403).json({ success: false, code: 'ADMIN_REGISTRY_RESTRICTED_FORBIDDEN', error: 'Restricted correspondence permission required' });
      }
      const id = idGenerator('COR');
      const params = { id, ...payload, ...commonParams(identity), created_at: now(), ...auditParams(identity, 'correspondence', id, 'create', Object.keys(payload)) };
      const [rows] = await run(`
        BEGIN TRANSACTION;
        INSERT INTO ${correspondenceTable}
          (id, tenant_id, receipt_date, direction, channel, sender, recipient, subject,
           category, confidentiality, linked_person_or_case, ged_reference,
           receipt_evidence_reference, owner, next_action, status, deadline,
           created_by_user_id, created_by_name, created_at, updated_by_user_id, updated_at, deleted_at)
        VALUES (@id, @tenant_id, DATE(@receipt_date), @direction, @channel, @sender,
          @recipient, @subject, @category, @confidentiality, @linked_person_or_case,
          @ged_reference, @receipt_evidence_reference, @owner, @next_action, @status,
          NULLIF(DATE(@deadline), DATE('1970-01-01')), @user_id, @user_name,
          TIMESTAMP(@created_at), @user_id, TIMESTAMP(@created_at), NULL);
        INSERT INTO ${auditTable}
          (id, tenant_id, actor_user_id, actor_name, entity_type, entity_id, action, event_at, metadata_json)
        VALUES (@audit_id, @tenant_id, @user_id, @user_name, @entity_type, @entity_id,
          @action, TIMESTAMP(@event_at), @metadata_json);
        COMMIT TRANSACTION;
        SELECT id, receipt_date, direction, channel, sender, recipient, subject, category,
          confidentiality, linked_person_or_case, ged_reference, receipt_evidence_reference,
          owner, next_action, status, deadline, created_by_user_id, created_by_name,
          created_at, updated_at
        FROM ${correspondenceTable} WHERE tenant_id=@tenant_id AND id=@id AND deleted_at IS NULL;
      `, { ...params, deadline: payload.deadline || '1970-01-01' });
      return res.status(201).json({ success: true, data: rows[0], source: 'bigquery' });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  const updateCorrespondence = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.CORRESPONDENCE_WRITE);
    if (!identity) return;
    try {
      const payload = normalizeCorrespondencePayload(req.body);
      if (['restricted_hr', 'confidential'].includes(payload.confidentiality)
        && !identity.permissions.has(PERMISSIONS.CORRESPONDENCE_RESTRICTED)) {
        return res.status(403).json({ success: false, code: 'ADMIN_REGISTRY_RESTRICTED_FORBIDDEN', error: 'Restricted correspondence permission required' });
      }
      const id = cleanString(req.params.id, 'id', { required: true, max: 120 });
      const existing = await findVisibleEntity({
        table: correspondenceTable,
        id,
        identity,
        restrictedCondition: "confidentiality NOT IN ('restricted_hr', 'confidential') OR @can_read_restricted_correspondence OR created_by_user_id=@user_id"
      });
      if (!existing) return res.status(404).json({ success: false, code: 'ADMIN_REGISTRY_NOT_FOUND', error: 'Correspondence not found' });
      const params = { id, ...payload, ...commonParams(identity), updated_at: now(), ...auditParams(identity, 'correspondence', id, 'update', Object.keys(payload)), deadline: payload.deadline || '1970-01-01' };
      const [rows] = await run(`
        BEGIN TRANSACTION;
        UPDATE ${correspondenceTable}
        SET receipt_date=DATE(@receipt_date), direction=@direction, channel=@channel,
          sender=@sender, recipient=@recipient, subject=@subject, category=@category,
          confidentiality=@confidentiality, linked_person_or_case=@linked_person_or_case,
          ged_reference=@ged_reference, receipt_evidence_reference=@receipt_evidence_reference,
          owner=@owner, next_action=@next_action, status=@status,
          deadline=NULLIF(DATE(@deadline), DATE('1970-01-01')),
          updated_by_user_id=@user_id, updated_at=TIMESTAMP(@updated_at)
        WHERE tenant_id=@tenant_id AND id=@id AND deleted_at IS NULL;
        INSERT INTO ${auditTable}
          (id, tenant_id, actor_user_id, actor_name, entity_type, entity_id, action, event_at, metadata_json)
        VALUES (@audit_id, @tenant_id, @user_id, @user_name, @entity_type, @entity_id,
          @action, TIMESTAMP(@event_at), @metadata_json);
        COMMIT TRANSACTION;
        SELECT id, receipt_date, direction, channel, sender, recipient, subject, category,
          confidentiality, linked_person_or_case, ged_reference, receipt_evidence_reference,
          owner, next_action, status, deadline, created_by_user_id, created_by_name,
          created_at, updated_at
        FROM ${correspondenceTable} WHERE tenant_id=@tenant_id AND id=@id AND deleted_at IS NULL;
      `, params);
      if (!rows[0]) return res.status(404).json({ success: false, code: 'ADMIN_REGISTRY_NOT_FOUND', error: 'Correspondence not found' });
      return res.json({ success: true, data: rows[0], source: 'bigquery' });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  const deleteCorrespondence = async (req, res) => {
    const identity = authorize(req, res, PERMISSIONS.CORRESPONDENCE_WRITE);
    if (!identity) return;
    try {
      const id = cleanString(req.params.id, 'id', { required: true, max: 120 });
      const existing = await findVisibleEntity({
        table: correspondenceTable,
        id,
        identity,
        restrictedCondition: "confidentiality NOT IN ('restricted_hr', 'confidential') OR @can_read_restricted_correspondence OR created_by_user_id=@user_id"
      });
      if (!existing) return res.status(404).json({ success: false, code: 'ADMIN_REGISTRY_NOT_FOUND', error: 'Correspondence not found' });
      const params = { id, ...commonParams(identity), deleted_at: now(), ...auditParams(identity, 'correspondence', id, 'delete', ['deleted_at']) };
      await run(`
        BEGIN TRANSACTION;
        UPDATE ${correspondenceTable}
        SET deleted_at=TIMESTAMP(@deleted_at), updated_by_user_id=@user_id,
          updated_at=TIMESTAMP(@deleted_at)
        WHERE tenant_id=@tenant_id AND id=@id AND deleted_at IS NULL
          AND (confidentiality NOT IN ('restricted_hr', 'confidential')
            OR @can_read_restricted_correspondence OR created_by_user_id=@user_id);
        INSERT INTO ${auditTable}
          (id, tenant_id, actor_user_id, actor_name, entity_type, entity_id, action, event_at, metadata_json)
        VALUES (@audit_id, @tenant_id, @user_id, @user_name, @entity_type, @entity_id,
          @action, TIMESTAMP(@event_at), @metadata_json);
        COMMIT TRANSACTION;
      `, params);
      return res.json({ success: true, id });
    } catch (error) {
      return respondError(res, error, logger);
    }
  };

  return {
    listResources,
    createResource,
    updateResource,
    deleteResource,
    listCorrespondence,
    createCorrespondence,
    updateCorrespondence,
    deleteCorrespondence,
    listAuditEvents
  };
};

module.exports = {
  PERMISSIONS,
  ADMINISTRATION_TABLE_CONTRACTS,
  RegistryValidationError,
  buildAdministrationRegistrySchemaStatements,
  ensureAdministrationRegistrySchema,
  defaultPermissionsForRole,
  permissionsForAccount,
  normalizeResourcePayload,
  normalizeCorrespondencePayload,
  parsePagination,
  parseAuditMetadata,
  createAdministrationRegistryHandlers
};

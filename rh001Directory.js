const fs = require('fs');

const DOCUMENT_FIELDS = Object.freeze([
  'schema_version',
  'classification',
  'status',
  'approved_by',
  'approved_on',
  'records'
]);

const DIRECTORY_FIELDS = Object.freeze([
  'person_id',
  'display_name',
  'preferred_name',
  'member_type',
  'team',
  'subgroup',
  'position',
  'active'
]);

const ALLOWED_MEMBER_TYPES = new Set(['Fondateur', 'Associe']);
const ALLOWED_TEAMS = new Set(['TZH', 'TSN']);
const ALLOWED_DOCUMENT_STATUS = 'validated_documentary';
const FORBIDDEN_KEYS = new Set([
  'email',
  'email_pro',
  'email_perso',
  'phone',
  'telephone',
  'matricule',
  'password',
  'mot_de_passe',
  'legal_name',
  'identity_aliases',
  'identity_evidence_ref',
  'access_role',
  'permission_scope',
  'delegation_id'
]);

const normalizeRole = (role) => {
  const normalized = String(role || '').trim().toLowerCase();
  if (['admin', 'administrateur', 'administrator', 'manager'].includes(normalized)) return 'Admin';
  if (['utilisateur', 'user'].includes(normalized)) return 'Utilisateur';
  return '';
};

const parseAllowedRoles = (value) => {
  const raw = value || 'Admin,Utilisateur';
  return new Set(
    String(raw)
      .split(',')
      .map(normalizeRole)
      .filter(Boolean)
  );
};

const isRoleAllowed = (role, allowedRoles) => (
  allowedRoles.has(normalizeRole(role))
);

const isFeatureEnabled = (value) => String(value || '').trim().toLowerCase() === 'true';

const parsePagination = (query = {}) => {
  const rawLimit = Number.parseInt(query.limit, 10);
  const rawOffset = Number.parseInt(query.offset, 10);
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 100,
    offset: Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0
  };
};

const assertNoSensitiveContent = (value, path = 'root') => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveContent(item, `${path}[${index}]`));
    return;
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new Error(`Forbidden RH-001 key at ${path}.${key}`);
      }
      assertNoSensitiveContent(item, `${path}.${key}`);
    });
    return;
  }

  if (typeof value === 'string' && /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value)) {
    throw new Error(`Email-like value forbidden at ${path}`);
  }
};

const assertExactFields = (value, expectedFields, path) => {
  const keys = Object.keys(value);
  const unexpectedKeys = keys.filter((key) => !expectedFields.includes(key));
  if (unexpectedKeys.length) {
    throw new Error(`Unexpected RH-001 fields at ${path}: ${unexpectedKeys.join(', ')}`);
  }
  expectedFields.forEach((field) => {
    if (!(field in value)) throw new Error(`Missing ${field} at ${path}`);
  });
};

const assertNonEmptyString = (value, field, path, maxLength = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Invalid ${field} at ${path}`);
  }
};

const isIsoDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const validateDirectoryDocument = (document) => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('RH-001 directory must be an object');
  }
  assertExactFields(document, DOCUMENT_FIELDS, 'root');
  if (document.schema_version !== 'rh001-directory-v1') {
    throw new Error('Unsupported RH-001 directory schema');
  }
  if (document.classification !== 'C2') {
    throw new Error('RH-001 directory classification must be C2');
  }
  if (document.status !== ALLOWED_DOCUMENT_STATUS) {
    throw new Error(`RH-001 directory status must be ${ALLOWED_DOCUMENT_STATUS}`);
  }
  assertNonEmptyString(document.approved_by, 'approved_by', 'root');
  if (!isIsoDate(document.approved_on)) {
    throw new Error('Invalid approved_on at root');
  }
  if (!Array.isArray(document.records)) {
    throw new Error('RH-001 directory records must be an array');
  }

  assertNoSensitiveContent(document);

  const personIds = new Set();
  const displayNames = new Set();
  document.records.forEach((record, index) => {
    const path = `records[${index}]`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Invalid RH-001 record at ${path}`);
    }
    assertExactFields(record, DIRECTORY_FIELDS, path);
    if (!/^PER-2SG-\d{4}$/.test(record.person_id)) {
      throw new Error(`Invalid person_id at ${path}`);
    }
    assertNonEmptyString(record.display_name, 'display_name', path);
    assertNonEmptyString(record.preferred_name, 'preferred_name', path, 100);
    assertNonEmptyString(record.position, 'position', path);
    if (personIds.has(record.person_id)) {
      throw new Error(`Duplicate person identity at ${path}`);
    }
    if (displayNames.has(record.display_name)) {
      throw new Error(`Duplicate display_name at ${path}`);
    }
    if (!ALLOWED_MEMBER_TYPES.has(record.member_type)) {
      throw new Error(`Invalid member_type at ${path}`);
    }
    if (!ALLOWED_TEAMS.has(record.team)) {
      throw new Error(`Invalid team at ${path}`);
    }
    if (record.subgroup !== null) {
      assertNonEmptyString(record.subgroup, 'subgroup', path, 100);
      if (!record.subgroup.startsWith(`${record.team}-`)) {
        throw new Error(`Subgroup must belong to team at ${path}`);
      }
    }
    if (typeof record.active !== 'boolean') {
      throw new Error(`Invalid active flag at ${path}`);
    }
    personIds.add(record.person_id);
    displayNames.add(record.display_name);
  });

  return document;
};

const readDirectoryDocument = async (filePath) => {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  return validateDirectoryDocument(JSON.parse(raw));
};

const projectDirectoryRecord = (record) => Object.fromEntries(
  DIRECTORY_FIELDS.map((field) => [field, record[field]])
);

const buildDirectoryPage = (document, query = {}) => {
  const { limit, offset } = parsePagination(query);
  const records = document.records.map(projectDirectoryRecord);
  return {
    data: records.slice(offset, offset + limit),
    count: Math.max(Math.min(records.length - offset, limit), 0),
    total: records.length,
    limit,
    offset
  };
};

const createMembersDirectoryHandler = ({
  enabled,
  allowedRoles,
  directoryPath,
  readDocument = readDirectoryDocument,
  now = () => new Date().toISOString(),
  logger = console
}) => async (req, res) => {
  if (!enabled) {
    return res.status(404).json({
      success: false,
      code: 'RH001_DIRECTORY_DISABLED',
      error: 'Annuaire RH-001 indisponible'
    });
  }

  if (!req.user) {
    return res.status(401).json({
      success: false,
      code: 'RH001_DIRECTORY_UNAUTHENTICATED',
      error: 'Authentification requise'
    });
  }

  if (!isRoleAllowed(req.user.role, allowedRoles)) {
    return res.status(403).json({
      success: false,
      code: 'RH001_DIRECTORY_FORBIDDEN',
      error: 'Acces refuse'
    });
  }

  try {
    const directory = await readDocument(directoryPath);
    const page = buildDirectoryPage(directory, req.query);
    return res.json({
      success: true,
      ...page,
      classification: directory.classification,
      source_status: directory.status,
      timestamp: now()
    });
  } catch (error) {
    logger.error('RH-001 members directory error:', error.message);
    return res.status(500).json({
      success: false,
      code: 'RH001_DIRECTORY_INVALID',
      error: 'Annuaire RH-001 invalide'
    });
  }
};

module.exports = {
  DOCUMENT_FIELDS,
  DIRECTORY_FIELDS,
  buildDirectoryPage,
  createMembersDirectoryHandler,
  isFeatureEnabled,
  isRoleAllowed,
  normalizeRole,
  parseAllowedRoles,
  parsePagination,
  readDirectoryDocument,
  validateDirectoryDocument
};

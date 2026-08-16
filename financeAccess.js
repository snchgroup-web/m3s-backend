const PERMISSIONS = Object.freeze({
  READ: 'finance:read',
  WRITE: 'finance:write',
  SOCIAL_READ: 'finance:social:read',
  REAL_ESTATE_READ: 'finance:real-estate:read',
  REAL_ESTATE_WRITE: 'finance:real-estate:write'
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

const LEGACY_PERMISSION_MAP = Object.freeze({
  'read finance': [PERMISSIONS.READ],
  'create finance': [PERMISSIONS.WRITE],
  'update finance': [PERMISSIONS.WRITE],
  'delete finance': [PERMISSIONS.WRITE],
  'read finance social': [PERMISSIONS.SOCIAL_READ],
  'read finance real estate': [PERMISSIONS.REAL_ESTATE_READ],
  'manage finance real estate': [PERMISSIONS.REAL_ESTATE_READ, PERMISSIONS.REAL_ESTATE_WRITE]
});

const normalize = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const defaultPermissionsForRole = role => {
  const normalized = normalize(role);
  const founderRoles = new Set(['fondateur', 'membre fondateur', 'manager']);
  const financeRoles = new Set([
    'admin finance',
    'finance',
    'finances',
    'responsable finance',
    'responsable finances',
    'finance manager',
    'finanzverantwortung'
  ]);

  if (founderRoles.has(normalized) || financeRoles.has(normalized)) {
    return [...ALL_PERMISSIONS];
  }

  // The 2SG governance grants authenticated members user-level access to
  // other functions, while sensitive scopes remain explicitly restricted.
  return [PERMISSIONS.READ];
};

const normalizeExplicitPermissions = permissions => {
  const normalized = new Set();
  (Array.isArray(permissions) ? permissions : []).forEach(permission => {
    if (ALL_PERMISSIONS.includes(permission)) {
      normalized.add(permission);
      return;
    }
    const legacy = LEGACY_PERMISSION_MAP[normalize(permission)] || [];
    legacy.forEach(item => normalized.add(item));
  });
  return [...normalized];
};

const hasRecognizedFinancePermission = permissions => (
  (Array.isArray(permissions) ? permissions : []).some(permission => (
    ALL_PERMISSIONS.includes(permission) || Boolean(LEGACY_PERMISSION_MAP[normalize(permission)])
  ))
);

const hasFinancePermissionConfiguration = account => (
  Array.isArray(account?.financePermissions) || hasRecognizedFinancePermission(account?.permissions)
);

const permissionsForAccount = account => {
  if (Array.isArray(account?.financePermissions)) {
    return normalizeExplicitPermissions(account.financePermissions);
  }
  if (hasRecognizedFinancePermission(account?.permissions)) {
    return normalizeExplicitPermissions(account.permissions);
  }
  return defaultPermissionsForRole(account?.role);
};

const permissionsForUser = user => {
  const explicit = normalizeExplicitPermissions(user?.permissions);
  if (user?.financePermissionsExplicit === true) return explicit;
  return [...new Set([...defaultPermissionsForRole(user?.role), ...explicit])];
};

const createFinanceAuthorizationMiddleware = permission => (req, res, next) => {
  if (!req.user?.id || !req.user?.tenantId) {
    return res.status(401).json({
      success: false,
      code: 'FINANCE_UNAUTHENTICATED',
      error: 'Authentication required'
    });
  }

  if (!permissionsForUser(req.user).includes(permission)) {
    return res.status(403).json({
      success: false,
      code: 'FINANCE_FORBIDDEN',
      error: 'Finance permission required'
    });
  }

  return next();
};

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  defaultPermissionsForRole,
  normalizeExplicitPermissions,
  hasFinancePermissionConfiguration,
  permissionsForAccount,
  permissionsForUser,
  createFinanceAuthorizationMiddleware
};

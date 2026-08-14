const DEBUG_ALLOWED_ROLES = new Set([
  'fondateur',
  'membre fondateur',
  'administrateur',
  'administrator',
  'manager'
]);

const normalizeRole = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const isDebugRoleAllowed = role => DEBUG_ALLOWED_ROLES.has(normalizeRole(role));

const createDebugAccessMiddleware = authenticateRequest => (req, res, next) => (
  authenticateRequest(req, res, () => {
    if (!isDebugRoleAllowed(req.user?.role)) {
      return res.status(403).json({
        success: false,
        code: 'DEBUG_ACCESS_FORBIDDEN',
        error: 'Accès diagnostic non autorisé'
      });
    }
    return next();
  })
);

module.exports = {
  DEBUG_ALLOWED_ROLES,
  normalizeRole,
  isDebugRoleAllowed,
  createDebugAccessMiddleware
};

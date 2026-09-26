function ownAccountDiagnosticNoStore(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  next();
}

function registerOwnAccountDiagnosticRoute(app, { authenticate, loadAccounts }) {
  app.get('/api/auth/account-diagnostic', authenticate('account:read'), async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    const validId = value => typeof value === 'string' && value.length > 0 &&
      value.length <= 128 && value === value.trim();
    const validGrants = value => Array.isArray(value) && value.every(validId);
    if (!validId(req.user?.id) || !validId(req.user?.tenantId) ||
        !validGrants(req.user?.permissions)) {
      return res.status(401).json({ success: false, error: 'ACCESS_DENIED' });
    }
    const { id, tenantId } = req.user;
    const sessionPermissions = [...req.user.permissions];
    try {
      const accounts = await loadAccounts(Object.freeze({ id, tenantId }));
      if (!Array.isArray(accounts) || accounts.length !== 1 || accounts[0]?.id !== id ||
          accounts[0]?.tenantId !== tenantId || accounts[0]?.active !== true) {
        return res.status(401).json({ success: false, error: 'ACCESS_DENIED' });
      }
      const account = accounts[0];
      if (!validGrants(account.permissions)) {
        return res.status(409).json({ success: false, error: 'EXPLICIT_PERMISSIONS_UNAVAILABLE' });
      }
      return res.json({ success: true, scope: 'current-account', account: { id, tenantId,
        active: true, explicitPermissions: [...new Set(account.permissions)],
        effectivePermissions: [...new Set(sessionPermissions.filter(value => account.permissions.includes(value)))] } });
    } catch {
      return res.status(503).json({ success: false, error: 'ACCOUNT_UNAVAILABLE' });
    }
  });
}

// This adapter registers only the own-account diagnostic, never business routes.
function createSanitizedOwnAccountLoader(getAccounts) {
  if (typeof getAccounts !== 'function') throw new TypeError('INVALID_ACCOUNT_LOADER');
  return async ({ id, tenantId }) => {
    const accounts = await getAccounts();
    if (!Array.isArray(accounts)) throw new Error('ACCOUNT_UNAVAILABLE');
    return accounts.filter(account => account && account.id === id && account.tenantId === tenantId)
      .map(account => ({ id: account.id, tenantId: account.tenantId, active: account.active,
        permissions: Array.isArray(account.permissions) ? [...account.permissions] : null }));
  };
}

function registerHistoricalOwnAccountDiagnosticRoute(app, { enabled = false, verifyToken, loadAccounts }) {
  if (enabled !== true) return;
  if (typeof verifyToken !== 'function' || typeof loadAccounts !== 'function') {
    throw new TypeError('INVALID_DIAGNOSTIC_CONFIGURATION');
  }
  const validId = value => typeof value === 'string' && value.length > 0 &&
    value.length <= 128 && value === value.trim();
  registerOwnAccountDiagnosticRoute(app, { loadAccounts, authenticate: () => async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const header = req.get('authorization');
      if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,16384}$/.test(header) ||
          header !== header.trim()) throw new Error('INVALID_HEADER');
      // Inject the existing signature/expiry verifier, not a JWT decoder.
      const payload = await verifyToken(header.slice(7));
      if (!validId(payload?.id) || !validId(payload?.tenantId) ||
          !Array.isArray(payload?.permissions) || !payload.permissions.every(validId)) {
        throw new Error('INVALID_PRINCIPAL');
      }
      req.user = { id: payload.id, tenantId: payload.tenantId, permissions: [...payload.permissions] };
      return next();
    } catch {
      return res.status(401).json({ success: false, error: 'ACCESS_DENIED' });
    }
  } });
}

module.exports = { ownAccountDiagnosticNoStore, registerOwnAccountDiagnosticRoute,
  registerHistoricalOwnAccountDiagnosticRoute, createSanitizedOwnAccountLoader };

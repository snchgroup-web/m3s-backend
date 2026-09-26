const { createAccessGate } = require('./identityAccessGate');
const { createIdentityAccountReader } = require('./identityAccountReader');

function noStore(res) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
}

// A single startup choice: provider failures never fall back to a legacy session.
// The caller must inject an authorized Admin Auth instance and sanitized stores.
function createIdentityProductionBridge(options = {}) {
  const { mode = 'legacy', authenticateLegacy } = options;
  if (!['legacy', 'google'].includes(mode) || typeof authenticateLegacy !== 'function') {
    throw new TypeError('INVALID_IDENTITY_MODE');
  }
  if (mode === 'legacy') {
    return Object.freeze({ mode, authenticate: authenticateLegacy,
      guardPasswordLogin: (_req, _res, next) => next(),
      currentAccount: (_req, res) => {
        noStore(res);
        return res.status(404).json({ success: false, code: 'IDENTITY_NOT_ENABLED' });
      } });
  }
  const { auth, projectId, tenantId = null, readLinks, readAccounts, loadProfile, now } = options;
  if (typeof loadProfile !== 'function') throw new TypeError('INVALID_PROFILE_READER');
  const resolveBindings = createIdentityAccountReader({ readLinks, readAccounts });
  const authorize = createAccessGate({ auth, projectId, tenantId, resolveBindings, now });

  async function authenticate(req, res, next) {
    noStore(res);
    try {
      // Ignore prefilled req.user, token roles and the historical signing secret.
      const principal = await authorize(req.get('authorization'));
      const profile = await loadProfile({ id: principal.userId, tenantId: principal.organizationId });
      if (!profile || profile.id !== principal.userId || profile.tenantId !== principal.organizationId || profile.active !== true) {
        throw new Error('ACCOUNT_UNAVAILABLE');
      }
      req.user = Object.freeze({ id: principal.userId, tenantId: principal.organizationId,
        role: typeof profile.role === 'string' ? profile.role : 'Utilisateur', authProvider: 'google',
        permissions: principal.permissions, permissionsExplicit: true,
        financePermissionsExplicit: true });
      return next();
    } catch {
      delete req.user;
      return res.status(401).json({ success: false, code: 'ACCESS_DENIED' });
    }
  }

  return Object.freeze({ mode, authenticate,
    guardPasswordLogin: (_req, res) => {
      noStore(res);
      return res.status(409).json({ success: false, code: 'AUTH_PROVIDER_REQUIRED' });
    },
    // Self-service profile read needs no new business permission. Existing routes
    // remain responsible for checking the explicit permission set above.
    currentAccount: (req, res) => authenticate(req, res, async () => {
      try {
        const { id, tenantId: organizationId } = req.user;
        const profile = await loadProfile(Object.freeze({ id, tenantId: organizationId }));
        if (!profile || profile.id !== id || profile.tenantId !== organizationId ||
            profile.active !== true || typeof profile.name !== 'string' ||
            !profile.name.trim() || typeof profile.email !== 'string' || !profile.email.trim()) {
          return res.status(401).json({ success: false, code: 'ACCESS_DENIED' });
        }
        return res.json({ success: true, user: { ...req.user, name: profile.name,
          email: profile.email, role: typeof profile.role === 'string' ? profile.role : 'Utilisateur' } });
      } catch {
        return res.status(503).json({ success: false, code: 'ACCOUNT_UNAVAILABLE' });
      }
    }) });
}

module.exports = { createIdentityProductionBridge };

const { createIdentityProductionBridge } = require('./identityProductionBridge');
const { resolveAccountIdentity } = require('./authConfiguration');
const { permissionsForAccount: administrationPermissions } = require('./administrationRegistries');
const { permissionsForAccount: financePermissions } = require('./financeAccess');

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim();
function createIdentityRuntime({ env, getAccounts, credentials, authenticateLegacy, createAuth = defaultAuth }) {
  const mode = env.M3S_IDENTITY_MODE || 'legacy';
  if (mode === 'legacy') return { ...createIdentityProductionBridge({ mode, authenticateLegacy }),
    publicConfig: { success: true, provider: 'legacy' } };
  if (mode !== 'google' || env.API_REQUIRE_AUTH !== 'true') throw new Error('INVALID_IDENTITY_MODE');
  let binding, config;
  try {
    binding = JSON.parse(env.M3S_IDENTITY_BINDING_JSON);
    config = JSON.parse(env.M3S_FIREBASE_WEB_CONFIG_JSON);
  } catch { throw new Error('INVALID_IDENTITY_CONFIGURATION'); }
  if (!binding || binding.active !== true || binding.tenantId !== null ||
      !['projectId', 'subject', 'userId', 'organizationId', 'role'].every(key => identifier(binding[key])) ||
      !Array.isArray(binding.permissions) || !binding.permissions.length || !binding.permissions.every(identifier) ||
      !config || config.projectId !== binding.projectId || config.authDomain !== `${binding.projectId}.firebaseapp.com` ||
      typeof config.apiKey !== 'string' || !/^AIza[A-Za-z0-9_-]{35}$/.test(config.apiKey) ||
      !identifier(config.appId) || !credentials?.client_email || !credentials?.private_key) {
    throw new Error('INVALID_IDENTITY_CONFIGURATION');
  }
  // Pin the existing M3S identity and approved grants. Historical role defaults
  // may only restrict this approved snapshot; they can never add a grant to it.
  function current() {
    const accounts = getAccounts();
    if (!Array.isArray(accounts)) return null;
    const matches = accounts.filter(account => {
      const identity = resolveAccountIdentity(account, env);
      return identity?.id === binding.userId && identity.tenantId === binding.organizationId;
    });
    if (matches.length !== 1 || matches[0].active === false || matches[0].role !== binding.role) return null;
    const source = matches[0];
    const effective = new Set([...administrationPermissions(source), ...financePermissions(source)]);
    return { id: binding.userId, tenantId: binding.organizationId, active: true,
      permissions: binding.permissions.filter(permission => effective.has(permission)),
      name: source.name || source.email, email: env.M3S_AUTH_SINGLE_ACCOUNT_LOGIN_EMAIL || source.email,
      role: source.role };
  }
  if (!current()) throw new Error('IDENTITY_ACCOUNT_NOT_LINKED');
  const bridge = createIdentityProductionBridge({ mode, authenticateLegacy, projectId: binding.projectId,
    auth: boundedAuth(createAuth({ credentials, projectId: binding.projectId })),
    readLinks: async key => key.projectId === binding.projectId && key.tenantId === null && key.subject === binding.subject
      ? [{ ...binding, permissions: [...binding.permissions] }] : [],
    readAccounts: async () => { const account = current(); return account ? [account] : []; },
    loadProfile: async () => current() });
  return { ...bridge, publicConfig: { success: true, provider: 'google',
    firebase: { apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, appId: config.appId } } };
}

function defaultAuth({ credentials, projectId }) {
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  return getAuth(initializeApp({ projectId, credential: cert(credentials) }, 'm3s-access'));
}

function boundedAuth(auth, timeoutMs = 8000, limit = 32) {
  let inFlight = 0;
  return { async verifyIdToken(token, revoked) {
    if (inFlight >= limit) throw new Error('IDENTITY_BUSY');
    inFlight += 1;
    const operation = Promise.resolve().then(() => auth.verifyIdToken(token, revoked))
      .finally(() => { inFlight -= 1; });
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('IDENTITY_TIMEOUT')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  } };
}
module.exports = { createIdentityRuntime, boundedAuth };

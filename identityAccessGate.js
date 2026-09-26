class AccessDenied extends Error {
  constructor() { super('ACCESS_DENIED'); this.status = 401; }
}

const boundedString = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && value === value.trim();

/** Official Admin Auth is injected, never initialized with discovered credentials.
 * Stable provider subject is resolved against CURRENT authorized M3S records.
 * A null permission authenticates only; business handlers still enforce grants.
 */
function createAccessGate({ auth, projectId, tenantId = null, resolveBindings, now = () => Date.now() }) {
  if (!boundedString(projectId) || typeof auth?.verifyIdToken !== 'function' ||
      typeof resolveBindings !== 'function' || (tenantId !== null && !boundedString(tenantId))) {
    throw new TypeError('INVALID_ACCESS_CONFIGURATION');
  }
  return async function authorize(header, requiredPermission = null) {
    try {
      if (typeof header !== 'string' || header !== header.trim() ||
          !/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(header)) throw new AccessDenied();
      if (requiredPermission !== null && !boundedString(requiredPermission)) throw new AccessDenied();
      const claims = await auth.verifyIdToken(header.slice(7), true);
      const seconds = Math.floor(now() / 1000);
      if (!claims || claims.iss !== `https://securetoken.google.com/${projectId}` ||
          claims.aud !== projectId || !boundedString(claims.sub) || claims.uid !== claims.sub ||
          !Number.isInteger(claims.exp) || claims.exp <= seconds ||
          !Number.isInteger(claims.iat) || claims.iat > seconds || claims.iat <= 0 ||
          claims.exp <= claims.iat || claims.exp - claims.iat > 3600 ||
          !Number.isInteger(claims.auth_time) || claims.auth_time > claims.iat || claims.auth_time <= 0 ||
          claims.email_verified !== true || claims.firebase?.sign_in_second_factor !== 'totp' ||
          (claims.firebase?.tenant ?? null) !== tenantId) throw new AccessDenied();
      const bindings = await resolveBindings({ projectId, tenantId, subject: claims.sub });
      if (!Array.isArray(bindings) || bindings.length !== 1) throw new AccessDenied();
      const binding = bindings[0];
      if (binding.active !== true || !boundedString(binding.userId) || !boundedString(binding.organizationId) ||
          !Array.isArray(binding.permissions) || !binding.permissions.every(boundedString) ||
          (requiredPermission !== null && !binding.permissions.includes(requiredPermission))) throw new AccessDenied();
      return Object.freeze({ userId: binding.userId, organizationId: binding.organizationId,
        permissions: Object.freeze([...binding.permissions]) });
    } catch {
      throw new AccessDenied();
    }
  };
}

module.exports = { AccessDenied, createAccessGate };

const { AccessDenied } = require('./identityAccessGate');

const identifier = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && value === value.trim();
const grants = value => Array.isArray(value) && value.every(identifier);

// Inject only current authorized metadata, never a credential-bearing account JSON.
function createIdentityAccountReader({ readLinks, readAccounts }) {
  if (typeof readLinks !== 'function' || typeof readAccounts !== 'function') {
    throw new TypeError('INVALID_ACCOUNT_READER_CONFIGURATION');
  }
  return async function readBindings({ projectId, tenantId, subject }) {
    try {
      if (!identifier(projectId) || !identifier(subject) ||
          (tenantId !== null && !identifier(tenantId))) throw new AccessDenied();
      const key = Object.freeze({ projectId, tenantId, subject });
      const links = await readLinks(key);
      if (!Array.isArray(links) || links.length !== 1) throw new AccessDenied();
      const link = links[0];
      if (!link || link.projectId !== projectId || link.tenantId !== tenantId ||
          link.subject !== subject || link.active !== true || !identifier(link.userId) ||
          !identifier(link.organizationId) || !grants(link.permissions)) throw new AccessDenied();
      const { userId, organizationId } = link;
      const approvedPermissions = [...link.permissions];
      const accounts = await readAccounts(Object.freeze({ id: userId, tenantId: organizationId }));
      if (!Array.isArray(accounts) || accounts.length !== 1) throw new AccessDenied();
      const account = accounts[0];
      if (!account || account.id !== userId || account.tenantId !== organizationId ||
          account.active !== true || !grants(account.permissions)) throw new AccessDenied();
      const permissions = [...new Set(approvedPermissions.filter(permission => account.permissions.includes(permission)))];
      return [{ ...key, userId, organizationId, active: true, permissions }];
    } catch {
      throw new AccessDenied();
    }
  };
}

module.exports = { createIdentityAccountReader };

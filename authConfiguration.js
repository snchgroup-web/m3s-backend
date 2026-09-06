const crypto = require('node:crypto');

const DEFAULT_SECRET = 'm3s-development-secret-change-me';
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const MIN_PASSWORD_ITERATIONS = 120000;
const MAX_PASSWORD_ITERATIONS = 1000000;
const MAX_ACCOUNT_IDENTITY_LENGTH = 200;
const SIGNING_SECRET_BYTES = 32;
const SIGNING_SECRET_BASE64URL_LENGTH = 43;
const MIN_SIGNING_SECRET_DISTINCT_BYTES = 16;
const MAX_SIGNING_SECRET_BYTE_FREQUENCY = 4;
const MIN_SIGNING_SECRET_SHANNON_ENTROPY = 4;
const MAX_SIGNING_SECRET_ARITHMETIC_RUN = 7;
const MIN_SIGNING_SECRET_REPEATED_BLOCK = 1;
const SHARED_SIGNING_KEY_PROVIDER = Symbol('shared-signing-key-provider');
const MAX_SIGNING_KEYS = 3;
const SIGNING_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

function hasRepeatedSigningSecretBlock(decoded) {
  for (let blockLength = MIN_SIGNING_SECRET_REPEATED_BLOCK;
    blockLength * 2 <= decoded.length; blockLength++) {
    for (let start = 0; start + blockLength * 2 <= decoded.length; start++) {
      let repeated = true;
      for (let offset = 0; offset < blockLength; offset++) {
        if (decoded[start + offset] !== decoded[start + blockLength + offset]) {
          repeated = false;
          break;
        }
      }
      if (repeated) return true;
    }
  }
  return false;
}

function hasAcceptableSigningSecretDistribution(decoded) {
  const frequencies = new Map();
  for (const byte of decoded) frequencies.set(byte, (frequencies.get(byte) || 0) + 1);
  if (frequencies.size < MIN_SIGNING_SECRET_DISTINCT_BYTES
    || Math.max(...frequencies.values()) > MAX_SIGNING_SECRET_BYTE_FREQUENCY) return false;
  const entropy = [...frequencies.values()].reduce((total, count) => {
    const probability = count / decoded.length;
    return total - probability * Math.log2(probability);
  }, 0);
  if (entropy < MIN_SIGNING_SECRET_SHANNON_ENTROPY) return false;
  if (hasRepeatedSigningSecretBlock(decoded)) return false;
  let arithmeticRun = 2;
  let previousDelta = null;
  for (let index = 1; index < decoded.length; index++) {
    const delta = (decoded[index] - decoded[index - 1] + 256) % 256;
    arithmeticRun = delta === previousDelta ? arithmeticRun + 1 : 2;
    if (arithmeticRun > MAX_SIGNING_SECRET_ARITHMETIC_RUN) return false;
    previousDelta = delta;
  }
  return true;
}

function hasStrongSigningSecret(value) {
  if (typeof value !== 'string' || value.length !== SIGNING_SECRET_BASE64URL_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === SIGNING_SECRET_BYTES && decoded.toString('base64url') === value
    && hasAcceptableSigningSecretDistribution(decoded);
}

function createEnvironmentSigningKeyProvider(env = {}) {
  const raw = env.M3S_AUTH_SIGNING_KEYS_JSON;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'activeKeyId,keys'
    || !SIGNING_KEY_ID_PATTERN.test(parsed.activeKeyId)
    || !Array.isArray(parsed.keys) || !parsed.keys.length || parsed.keys.length > MAX_SIGNING_KEYS) {
    return null;
  }
  const ids = new Set();
  const secrets = new Set();
  const keys = [];
  for (const candidate of parsed.keys) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).sort().join(',') !== 'id,secret'
      || !SIGNING_KEY_ID_PATTERN.test(candidate.id)
      || !hasStrongSigningSecret(candidate.secret)
      || ids.has(candidate.id) || secrets.has(candidate.secret)) return null;
    ids.add(candidate.id);
    secrets.add(candidate.secret);
    keys.push(Object.freeze({ id: candidate.id, secret: candidate.secret }));
  }
  if (!ids.has(parsed.activeKeyId)) return null;
  const provider = { activeKeyId: parsed.activeKeyId };
  Object.defineProperty(provider, 'keys', { value: Object.freeze(keys), enumerable: false });
  Object.defineProperty(provider, SHARED_SIGNING_KEY_PROVIDER, { value: true });
  return Object.freeze(provider);
}

function isSharedSigningKeyProvider(provider) {
  return Boolean(provider?.[SHARED_SIGNING_KEY_PROVIDER]
    && SIGNING_KEY_ID_PATTERN.test(provider.activeKeyId)
    && Array.isArray(provider.keys)
    && provider.keys.some(key => key.id === provider.activeKeyId));
}

function signingKey(provider, keyId) {
  if (!isSharedSigningKeyProvider(provider)) return null;
  return provider.keys.find(key => key.id === keyId) || null;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwtToken(payload, { provider = null, fallbackSecret = null, now = () => Date.now(),
  lifetimeSeconds = 60 * 60 * 12 } = {}) {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 24 * 60 * 60) {
    throw new Error('Invalid token lifetime');
  }
  const activeKey = signingKey(provider, provider?.activeKeyId);
  const secret = activeKey?.secret || fallbackSecret;
  if (typeof secret !== 'string' || !secret) throw new Error('Signing key unavailable');
  const header = base64UrlJson(activeKey
    ? { alg: 'HS256', typ: 'JWT', kid: activeKey.id }
    : { alg: 'HS256', typ: 'JWT' });
  const issuedAt = Math.floor(now() / 1000);
  const body = base64UrlJson({ ...payload, iat: issuedAt, exp: issuedAt + lifetimeSeconds });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function parseBase64UrlJson(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return null;
    const parsed = JSON.parse(decoded.toString('utf8'));
    return base64UrlJson(parsed) === value ? parsed : null;
  } catch {
    return null;
  }
}

function verifyJwtToken(token, { provider = null, fallbackSecret = null, now = () => Date.now() } = {}) {
  if (typeof token !== 'string' || token.length > 16384) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, signature] = parts;
  const header = parseBase64UrlJson(encodedHeader);
  const providerReady = isSharedSigningKeyProvider(provider);
  const expectedHeaderFields = providerReady ? ['alg', 'kid', 'typ'] : ['alg', 'typ'];
  if (!header || typeof header !== 'object' || Array.isArray(header)
    || Object.keys(header).sort().join(',') !== expectedHeaderFields.join(',')
    || header.alg !== 'HS256' || header.typ !== 'JWT') return null;
  const secret = providerReady ? signingKey(provider, header.kid)?.secret : fallbackSecret;
  if (typeof secret !== 'string' || !secret || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedBody}`).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const payload = parseBase64UrlJson(encodedBody);
  const currentTime = Math.floor(now() / 1000);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
    || payload.iat > currentTime + 60 || payload.exp <= currentTime || payload.exp <= payload.iat) return null;
  return payload;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function hasValidPasswordCredential(account) {
  const hash = decodeCanonicalBase64(account.passwordHash);
  const salt = decodeCanonicalBase64(account.passwordSalt);
  const iterations = Number(account.passwordIterations);
  return hash?.length === PASSWORD_HASH_BYTES
    && salt?.length === PASSWORD_SALT_BYTES
    && Number.isInteger(iterations)
    && iterations >= MIN_PASSWORD_ITERATIONS
    && iterations <= MAX_PASSWORD_ITERATIONS;
}

function hasPasswordHashFields(account) {
  return ['passwordHash', 'passwordSalt', 'passwordIterations']
    .some(field => account?.[field] !== undefined && account[field] !== null && account[field] !== '');
}

function normalizeLoginIdentifier(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function findUniqueLoginAccount(accounts = [], value) {
  const loginIdentifier = normalizeLoginIdentifier(value);
  if (!loginIdentifier) return null;
  const matches = accounts.filter(account => account?.active !== false
    && normalizeLoginIdentifier(account.email) === loginIdentifier);
  return matches.length === 1 ? matches[0] : null;
}

function resolveAccountIdentity(account, env = {}) {
  const rawId = account?.id || account?.userId || account?.email;
  const rawTenantId = account?.tenantId || account?.organizationId || env.M3S_DEFAULT_TENANT_ID || '2sg';
  if (typeof rawId !== 'string' || !rawId.trim()
    || rawId !== rawId.trim()
    || rawId.length > MAX_ACCOUNT_IDENTITY_LENGTH
    || typeof rawTenantId !== 'string' || !rawTenantId.trim()
    || rawTenantId !== rawTenantId.trim()
    || rawTenantId.length > MAX_ACCOUNT_IDENTITY_LENGTH) return null;
  return { id: rawId, tenantId: rawTenantId };
}

function inspectAccountIdentities(env, accounts) {
  const active = accounts.filter(account => account && account.active !== false);
  if (!active.length) return { ready: false, reason: 'no-active-account' };
  const loginIdentifiers = active.map(account => normalizeLoginIdentifier(account.email));
  if (loginIdentifiers.some(identifier => !identifier)) {
    return { ready: false, reason: 'login-identifier-missing' };
  }
  if (new Set(loginIdentifiers).size !== loginIdentifiers.length) {
    return { ready: false, reason: 'login-identifier-duplicate' };
  }
  const principals = active.map(account => resolveAccountIdentity(account, env));
  if (principals.some(principal => !principal)) {
    return { ready: false, reason: 'account-principal-invalid' };
  }
  const principalKeys = principals.map(principal => `${principal.tenantId}\u0000${principal.id}`);
  if (new Set(principalKeys).size !== principalKeys.length) {
    return { ready: false, reason: 'account-principal-duplicate' };
  }
  return { ready: true, active };
}

function inspectProductionAuthConfiguration(env = {}, accounts = [], signingKeyProvider = null) {
  if (!['production', 'development', 'test'].includes(env.NODE_ENV)) {
    return { ready: false, reason: 'runtime-environment-not-explicit' };
  }
  const production = env.NODE_ENV === 'production';
  const budgetRequested = env.FINANCE_BUDGET_DRAFTS_ENABLED === 'true';
  if (production && !budgetRequested) {
    return { ready: true, reason: 'production-budget-disabled' };
  }
  const configuredSigningSecret = typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
  if (production && configuredSigningSecret) {
    return { ready: false, reason: 'operator-signing-secret-forbidden' };
  }
  const signingSecretReady = production
    ? isSharedSigningKeyProvider(signingKeyProvider)
    : isSharedSigningKeyProvider(signingKeyProvider) || hasStrongSigningSecret(env.JWT_SECRET);
  const authenticatedBudgetRequested = budgetRequested
    && env.API_REQUIRE_AUTH === 'true' && signingSecretReady;
  if (!production && !authenticatedBudgetRequested) return { ready: true, reason: 'non-production' };
  if (env.API_REQUIRE_AUTH !== 'true') return { ready: false, reason: 'authentication-disabled' };
  if (!signingSecretReady) {
    return { ready: false, reason: 'signing-secret-not-ready' };
  }
  const identityInspection = inspectAccountIdentities(env, accounts);
  if (!identityInspection.ready) return identityInspection;
  const { active } = identityInspection;
  if (!production) {
    if (active.some(account => hasPasswordHashFields(account) && !hasValidPasswordCredential(account))) {
      return { ready: false, reason: 'password-credential-invalid' };
    }
    if (active.some(account => !hasPasswordHashFields(account)
      && !(typeof account.password === 'string' && account.password.length > 0))) {
      return { ready: false, reason: 'password-credential-missing' };
    }
    return { ready: true, reason: 'non-production-budget-identities-ready' };
  }
  if (active.some(account => typeof account.password === 'string' && account.password.length > 0)) {
    return { ready: false, reason: 'plaintext-password-present' };
  }
  if (active.some(account => !hasValidPasswordCredential(account))) {
    return { ready: false, reason: 'password-credential-invalid' };
  }
  return { ready: true, reason: 'ready' };
}

function assertProductionAuthConfiguration(env, accounts, signingKeyProvider) {
  const result = inspectProductionAuthConfiguration(env, accounts, signingKeyProvider);
  if (result.ready) return result;
  const error = new Error('Production authentication configuration is not ready');
  error.code = 'AUTH_CONFIGURATION_NOT_READY';
  error.safeReason = result.reason;
  throw error;
}

module.exports = {
  DEFAULT_SECRET,
  hasStrongSigningSecret,
  createEnvironmentSigningKeyProvider,
  isSharedSigningKeyProvider,
  signJwtToken,
  verifyJwtToken,
  inspectProductionAuthConfiguration,
  assertProductionAuthConfiguration,
  hasValidPasswordCredential,
  normalizeLoginIdentifier,
  findUniqueLoginAccount,
  resolveAccountIdentity
};

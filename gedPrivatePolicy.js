const { createHash } = require('node:crypto');

const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const contentTypeFor = entry => entry.name.endsWith('.docx') ? DOCX_MIME : 'application/pdf';
const categoryFor = entry => entry.category || 'unclassified';
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128;

// The pilot permits only an explicitly approved, pre-scanned batch. This is not
// a general upload policy or a grant inferred from the user's business role.
function readPolicy(env) {
  if (env.M3S_GED_PRIVATE_ENABLED !== 'true') return null;
  if (env.M3S_IDENTITY_MODE !== 'google' || env.API_REQUIRE_AUTH !== 'true') fail('GED_CONFIGURATION_DENIED');
  let binding, owner, manifest;
  try {
    binding = JSON.parse(env.M3S_IDENTITY_BINDING_JSON);
    owner = JSON.parse(env.M3S_GED_OWNER_JSON);
    manifest = JSON.parse(env.M3S_GED_IMPORT_MANIFEST_JSON);
  } catch { fail('GED_CONFIGURATION_DENIED'); }
  if (!owner || !identifier(owner.userId) || !identifier(owner.organizationId) ||
      owner.userId !== binding?.userId || owner.organizationId !== binding?.organizationId ||
      binding.active !== true || !Array.isArray(manifest) || manifest.length < 1 || manifest.length > 10) {
    fail('GED_CONFIGURATION_DENIED');
  }
  const seen = new Set();
  const documents = manifest.map(entry => {
    const keys = entry && Object.keys(entry).sort().join(',');
    if (!entry || !['name,sha256,size', 'category,name,sha256,size'].includes(keys) ||
        (entry.category !== undefined && !['personal', 'finance'].includes(entry.category)) ||
        !HASH.test(entry.sha256) || seen.has(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 10 || entry.size > MAX_BYTES ||
        typeof entry.name !== 'string' || !/^[\p{L}\p{N} ._()-]{1,140}\.(pdf|docx)$/u.test(entry.name) ||
        (entry.name.endsWith('.docx') && !entry.category) ||
        entry.name.startsWith('.') || entry.name.trim() !== entry.name) fail('GED_CONFIGURATION_DENIED');
    seen.add(entry.sha256);
    return Object.freeze({ ...entry });
  });
  return Object.freeze({ owner: Object.freeze({ ...owner }), documents: Object.freeze(documents) });
}

function scopeFor(policy, principal) {
  if (!policy || principal?.authProvider !== 'google' ||
      principal.id !== policy.owner.userId || principal.tenantId !== policy.owner.organizationId) fail('GED_ACCESS_DENIED');
  return Object.freeze({ tenant: digest(principal.tenantId), owner: digest(principal.id) });
}

function approvedDocument(policy, id, bytes) {
  const entry = typeof id === 'string' && HASH.test(id) && policy.documents.find(item => item.sha256 === id);
  if (!entry) fail('GED_DOCUMENT_NOT_APPROVED');
  if (bytes !== undefined && (!Buffer.isBuffer(bytes) || bytes.length !== entry.size || digest(bytes) !== entry.sha256 ||
      !(entry.name.endsWith('.docx') ? bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04])) :
        bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))))) fail('GED_DOCUMENT_NOT_APPROVED');
  return entry;
}

module.exports = { HASH, MAX_BYTES, DOCX_MIME, contentTypeFor, categoryFor, digest, fail, readPolicy, scopeFor, approvedDocument };

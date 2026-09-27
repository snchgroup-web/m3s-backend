const { readPolicy } = require('../gedPrivatePolicy');

// Local candidate preparation only. This does not approve, scan or upload files.
function mergeManifest(previous, additions) {
  const owner = { userId: 'local-validation', organizationId: 'local-validation' };
  const env = { M3S_GED_PRIVATE_ENABLED: 'true', M3S_GED_IMPORT_PROFILE: 'scans-v2',
    M3S_IDENTITY_MODE: 'google', API_REQUIRE_AUTH: 'true',
    M3S_GED_OWNER_JSON: JSON.stringify(owner),
    M3S_IDENTITY_BINDING_JSON: JSON.stringify({ ...owner, active: true }) };
  const validate = rows => readPolicy({ ...env, M3S_GED_IMPORT_MANIFEST_JSON: JSON.stringify(rows) }).documents;
  const base = validate(previous);
  if (!Array.isArray(additions)) throw new Error('GED_MANIFEST_INVALID_ADDITIONS');
  if (!additions.length) return [...base];
  const next = validate(additions);
  const merged = new Map(base.map(row => [row.sha256, row]));
  for (const row of next) {
    const old = merged.get(row.sha256);
    if (old && ['name', 'size', 'category'].some(key => old[key] !== row[key])) {
      throw new Error('GED_MANIFEST_EXISTING_ENTRY_CHANGED');
    }
    if (!old) merged.set(row.sha256, row);
  }
  return [...validate([...merged.values()])];
}

module.exports = { mergeManifest };

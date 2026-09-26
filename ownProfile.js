const { findUniqueLoginAccount, resolveAccountIdentity } = require('./authConfiguration');
const { validateDirectoryDocument } = require('./rh001Directory');

function profileNoStore(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

function createOwnProfileHandler({ getAccounts, readDirectory, env = process.env }) {
  return async (req, res) => {
    profileNoStore(req, res, () => {});
    try {
      const accounts = getAccounts();
      const email = env.M3S_AUTH_SINGLE_ACCOUNT_LOGIN_EMAIL;
      if (!email || !Array.isArray(accounts)) {
        return res.status(409).json({ success: false, code: 'PROFILE_NOT_LINKED' });
      }
      const account = findUniqueLoginAccount(accounts, email, {
        singleAccountLoginEmail: email,
        singleAccountSourceEmailSha256: env.M3S_AUTH_SINGLE_ACCOUNT_SOURCE_EMAIL_SHA256
      });
      const identity = resolveAccountIdentity(account, env);
      if (!account || !identity || !req.user?.id || !req.user?.tenantId ||
          identity.id !== req.user.id || identity.tenantId !== req.user.tenantId) {
        return res.status(403).json({ success: false, code: 'PROFILE_ACCESS_DENIED' });
      }
      let binding;
      try { binding = JSON.parse(env.M3S_AUTH_SINGLE_ACCOUNT_PROFILE_JSON || 'null'); }
      catch { binding = null; }
      if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
          Object.keys(binding).sort().join(',') !== 'personId,tenantId' ||
          !/^PER-2SG-\d{4}$/.test(binding.personId) || binding.tenantId !== identity.tenantId) {
        return res.status(409).json({ success: false, code: 'PROFILE_NOT_LINKED' });
      }
      const directory = validateDirectoryDocument(await readDirectory());
      const matches = directory.records.filter(row => row.person_id === binding.personId && row.active === true);
      if (matches.length !== 1) {
        return res.status(409).json({ success: false, code: 'PROFILE_NOT_LINKED' });
      }
      const person = matches[0];
      const photo = jpegPhoto((env.M3S_AUTH_SINGLE_ACCOUNT_PHOTO_JPEG || '') +
        (env.M3S_AUTH_SINGLE_ACCOUNT_PHOTO_JPEG_CONTINUED || ''));
      // Only the authenticated person's approved fields cross this boundary.
      return res.json({ success: true, scope: 'current-account',
        account: { email, role: typeof account.role === 'string' ? account.role : null },
        profile: { personId: person.person_id, displayName: person.display_name,
          memberType: person.member_type, team: person.team, position: person.position, photo },
        source: { id: 'RH-001', status: directory.status, approvedOn: directory.approved_on }
      });
    } catch {
      return res.status(503).json({ success: false, code: 'PROFILE_UNAVAILABLE' });
    }
  };
}

function jpegPhoto(value) {
  if (typeof value !== 'string' || value.length > 180000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 ||
      bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return null;
  return `data:image/jpeg;base64,${value}`;
}

module.exports = { profileNoStore, createOwnProfileHandler, jpegPhoto };

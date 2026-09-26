const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { findUniqueLoginAccount, resolveAccountIdentity } = require('../authConfiguration');

const professionalEmail = 'cheikh.ndiaye@seneswiss-group.com';
const original = { email: 'cheikh@example.test', name: 'Cheikh', role: 'Manager',
  passwordHash: 'synthetic-hash', active: true };
const override = { singleAccountLoginEmail: professionalEmail,
  singleAccountSourceEmailSha256: crypto.createHash('sha256').update(original.email).digest('hex') };

test('professional login email selects the same single account without rewriting credentials or identity', () => {
  const accounts = [original];
  const before = resolveAccountIdentity(original, { M3S_DEFAULT_TENANT_ID: '2sg' });
  assert.strictEqual(findUniqueLoginAccount(accounts, ' CHEIKH.NDIAYE@SENESWISS-GROUP.COM ', override), original);
  assert.equal(findUniqueLoginAccount(accounts, original.email, override), null);
  assert.deepEqual(resolveAccountIdentity(original, { M3S_DEFAULT_TENANT_ID: '2sg' }), before);
  assert.equal(original.email, 'cheikh@example.test');
  assert.equal(original.passwordHash, 'synthetic-hash');
  assert.equal(findUniqueLoginAccount(accounts, original.email), original);
});

test('professional override fails closed for invalid configuration and ambiguous accounts', () => {
  const accounts = [original];
  for (const invalid of ['not-an-email', ' Cheikh@example.test', 'CHEIKH@example.test',
    'cheikh@invalid', 'x'.repeat(255), null]) {
    assert.equal(findUniqueLoginAccount(accounts, professionalEmail,
      { singleAccountLoginEmail: invalid }), null);
    assert.equal(findUniqueLoginAccount(accounts, original.email,
      { singleAccountLoginEmail: invalid }), null);
  }
  assert.equal(findUniqueLoginAccount([original, { email: 'other@example.test', active: true }],
    professionalEmail, override), null);
  assert.equal(findUniqueLoginAccount([original, { active: true }], professionalEmail, override), null);
  assert.equal(findUniqueLoginAccount([original, { email: '  ' }], professionalEmail, override), null);
  assert.equal(findUniqueLoginAccount([{ ...original, email: 'replacement@example.test' }],
    professionalEmail, override), null);
  assert.equal(findUniqueLoginAccount(accounts, professionalEmail,
    { singleAccountLoginEmail: professionalEmail }), null);
  assert.equal(findUniqueLoginAccount(accounts, professionalEmail,
    { ...override, singleAccountSourceEmailSha256: '0'.repeat(64) }), null);
  assert.equal(findUniqueLoginAccount([{ ...original, active: false }], professionalEmail, override), null);
  assert.equal(findUniqueLoginAccount([], professionalEmail, override), null);
});

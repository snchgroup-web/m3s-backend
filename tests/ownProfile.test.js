const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { createOwnProfileHandler, profileNoStore, jpegPhoto } = require('../ownProfile');
const { signJwtToken, verifyJwtToken } = require('../authConfiguration');

const principal = { id: 'fixture-account', tenantId: 'fixture-org' };
const secret = 'synthetic-profile-test-only-not-production';
const account = { ...principal, email: 'old@example.test', role: 'Manager', passwordHash: 'never-return' };
const env = { M3S_AUTH_SINGLE_ACCOUNT_LOGIN_EMAIL: 'new@example.test',
  M3S_AUTH_SINGLE_ACCOUNT_SOURCE_EMAIL_SHA256: crypto.createHash('sha256').update(account.email).digest('hex'),
  M3S_AUTH_SINGLE_ACCOUNT_PROFILE_JSON: JSON.stringify({ personId: 'PER-2SG-9001', tenantId: principal.tenantId }) };
const directory = { schema_version: 'rh001-directory-v1', classification: 'C2',
  status: 'validated_documentary', approved_by: 'Fixture', approved_on: '2026-09-26',
  records: [{ person_id: 'PER-2SG-9001', display_name: 'Synthetic Person', preferred_name: 'Synthetic',
    member_type: 'Fondateur', team: 'TZH', subgroup: null, position: 'Synthetic function', active: true },
  { person_id: 'PER-2SG-9002', display_name: 'Other Person', preferred_name: 'Other',
    member_type: 'Associe', team: 'TSN', subgroup: null, position: 'Other function', active: true }] };

async function scenario(run) {
  const state = { accounts: structuredClone([account]), env: { ...env }, directory: structuredClone(directory) };
  const app = express();
  app.use('/api/auth/profile', profileNoStore);
  app.get('/api/auth/profile', (req, res, next) => {
    req.user = verifyJwtToken((req.headers.authorization || '').slice(7), { fallbackSecret: secret });
    return req.user ? next() : res.status(401).json({ success: false });
  }, createOwnProfileHandler({ getAccounts: () => state.accounts, env: state.env,
    readDirectory: async () => state.directory }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const token = signJwtToken(principal, { fallbackSecret: secret });
  const request = (bearer = token, method = 'GET', query = '') => fetch(
    `http://127.0.0.1:${server.address().port}/api/auth/profile${query}`,
    { method, headers: { Authorization: `Bearer ${bearer}` } });
  try { await run({ state, request, token }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('own profile joins current account to explicit person, ignores target query and returns no secrets', () => scenario(async ({ request }) => {
  const res = await request(undefined, 'GET', '?personId=PER-2SG-9002');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await res.json(), { success: true, scope: 'current-account',
    account: { email: 'new@example.test', role: 'Manager' },
    profile: { personId: 'PER-2SG-9001', displayName: 'Synthetic Person', memberType: 'Fondateur',
      team: 'TZH', position: 'Synthetic function', photo: null },
    source: { id: 'RH-001', status: 'validated_documentary', approvedOn: '2026-09-26' } });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request(undefined, method)).status, 404);
}));

test('invalid, foreign-account and foreign-tenant sessions are denied', () => scenario(async ({ request }) => {
  const invalid = await request('invalid');
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get('cache-control'), 'private, no-store');
  for (const payload of [{ ...principal, id: 'other' }, { ...principal, tenantId: 'other' }]) {
    assert.equal((await request(signJwtToken(payload, { fallbackSecret: secret }))).status, 403);
  }
}));

test('disabled, replaced or ambiguous accounts cannot use an existing session', () => scenario(async ({ state, request }) => {
  for (const accounts of [[], [{ ...account, active: false }], [{ ...account, email: 'other@example.test' }],
    [account, { active: true }], [account, account]]) {
    state.accounts = accounts;
    assert.equal((await request()).status, 403);
  }
}));

test('missing, malformed, cross-tenant and non-approved links fail closed', () => scenario(async ({ state, request }) => {
  for (const value of [undefined, '{', 'null', JSON.stringify({ personId: 'PER-2SG-9002', tenantId: 'other' }),
    JSON.stringify({ personId: 'PER-2SG-9999', tenantId: principal.tenantId }),
    JSON.stringify({ personId: 'PER-2SG-9001', tenantId: principal.tenantId, permissions: ['admin'] })]) {
    state.env.M3S_AUTH_SINGLE_ACCOUNT_PROFILE_JSON = value;
    assert.equal((await request()).status, 409);
  }
  state.env.M3S_AUTH_SINGLE_ACCOUNT_PROFILE_JSON = env.M3S_AUTH_SINGLE_ACCOUNT_PROFILE_JSON;
  state.directory.records[0].active = false;
  assert.equal((await request()).status, 409);
  state.directory.status = 'draft';
  assert.equal((await request()).status, 503);
}));

test('legacy identity is preserved when source account has no explicit identifiers', () => scenario(async ({ state, request }) => {
  state.accounts = [{ email: account.email, role: 'Manager' }];
  state.env.M3S_AUTH_SINGLE_ACCOUNT_PROFILE_JSON = JSON.stringify({ personId: 'PER-2SG-9001', tenantId: '2sg' });
  const token = signJwtToken({ id: account.email, tenantId: '2sg' }, { fallbackSecret: secret });
  assert.equal((await request(token)).status, 200);
  assert.deepEqual(state.accounts, [{ email: account.email, role: 'Manager' }]);
}));

test('split runtime photo is returned only when complete', () => scenario(async ({ state, request }) => {
  const jpeg = Buffer.from([255, 216, 0, 0, 255, 217]).toString('base64');
  state.env.M3S_AUTH_SINGLE_ACCOUNT_PHOTO_JPEG = jpeg.slice(0, 4);
  assert.equal((await (await request()).json()).profile.photo, null);
  state.env.M3S_AUTH_SINGLE_ACCOUNT_PHOTO_JPEG_CONTINUED = jpeg.slice(4);
  assert.equal((await (await request()).json()).profile.photo, `data:image/jpeg;base64,${jpeg}`);
}));

test('photo accepts only bounded canonical JPEG bytes, never URLs or SVG', () => {
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  assert.equal(jpegPhoto(jpeg), `data:image/jpeg;base64,${jpeg}`);
  for (const value of [undefined, 'https://external.test/photo', '<svg/>', 'A'.repeat(180001), 'YWJj', jpeg + '\n']) {
    assert.equal(jpegPhoto(value), null);
  }
});

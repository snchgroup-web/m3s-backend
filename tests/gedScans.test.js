const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { readPolicy, approvedDocument, contentTypeFor, digest, MAX_BYTES, SCAN_MAX_BYTES } = require('../gedPrivatePolicy');
const { mergeManifest } = require('../scripts/ged-merge-manifest');
const { createRegister } = require('../gedPrivateRegister');
const owner = { userId: 'synthetic-user', organizationId: 'synthetic-org' };
const env = { M3S_GED_PRIVATE_ENABLED: 'true', M3S_IDENTITY_MODE: 'google', API_REQUIRE_AUTH: 'true',
  M3S_GED_OWNER_JSON: JSON.stringify(owner), M3S_IDENTITY_BINDING_JSON: JSON.stringify({ ...owner, active: true }) };
const entry = (bytes, name = 'Synthetic.jpg') => ({ name, size: bytes.length, sha256: digest(bytes), category: 'finance' });
const jpeg = Buffer.concat([Buffer.from([255,216,255]), Buffer.from('synthetic-only'), Buffer.from([255,217])]);
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('synthetic-only'), Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130])]);
const policy = (rows, profile = 'scans-v2') => readPolicy({ ...env, M3S_GED_IMPORT_PROFILE: profile, M3S_GED_IMPORT_MANIFEST_JSON: JSON.stringify(rows) });

test('real transactional register creates and rereads scans up to the active policy limit', async () => {
  const db = new PGlite();
  try {
    await db.exec(readFileSync(require.resolve('../sql/ged-private-v1.sql'), 'utf8'));
    await db.exec(readFileSync(require.resolve('../sql/ged-scans-v3.sql'), 'utf8'));
    const pool = { async connect() { return { query: (sql, params) => db.query(sql, params), release() {} }; } };
    const scope = { tenant: 'a'.repeat(64), owner: 'b'.repeat(64) };
    const register = createRegister(pool, { maxBytes: SCAN_MAX_BYTES });
    for (const size of [MAX_BYTES + 1, SCAN_MAX_BYTES]) {
      const doc = { name: `Synthetic-${size}.jpg`, sha256: digest(String(size)), size, category: 'finance' };
      assert.equal((await register.create(scope, doc, '1')).created, true);
      assert.equal((await register.create(scope, doc, '1')).created, false);
      assert.equal((await register.read(scope, doc.sha256)).byte_size, size);
    }
    assert.equal((await register.list(scope)).length, 2);
    await assert.rejects(createRegister(pool).list(scope), /GED_REGISTER_UNAVAILABLE/);
    assert.throws(() => createRegister(pool, { maxBytes: SCAN_MAX_BYTES + 1 }));
    await assert.rejects(register.create(scope, { name: 'TooBig.jpg', sha256: digest('too-big'), size: SCAN_MAX_BYTES + 1 }, '2'));
    assert.equal((await register.list(scope)).length, 2);
  } finally { await db.close(); }
});

test('scan profile is opt-in; pilot limits and unknown-profile refusal remain', () => {
  assert.throws(() => policy([entry(jpeg)], 'pilot-v1'));
  assert.throws(() => policy([entry(jpeg)], 'typo'));
  const large = { ...entry(jpeg, 'Synthetic.pdf'), size: MAX_BYTES + 1 };
  assert.throws(() => policy([large], 'pilot-v1'));
  assert.equal(policy([large]).maxBytes, SCAN_MAX_BYTES);
});

test('exact approved JPEG/PNG signatures, hashes and classified types are required', () => {
  for (const [bytes, name, mime] of [[jpeg, 'Scan.jpg', 'image/jpeg'], [jpeg, 'Scan.jpeg', 'image/jpeg'], [png, 'Scan.png', 'image/png']]) {
    const doc = entry(bytes, name); const p = policy([doc]);
    assert.equal(contentTypeFor(doc), mime);
    assert.deepEqual(approvedDocument(p, doc.sha256, bytes), doc);
    assert.throws(() => approvedDocument(p, doc.sha256, Buffer.from('different bytes')));
    const fake = Buffer.from('<html>synthetic</html>'); const bad = entry(fake, name);
    assert.throws(() => approvedDocument(policy([bad]), bad.sha256, fake));
    assert.throws(() => policy([{ ...doc, category: undefined }]));
  }
  for (const name of ['Scan.svg', 'Scan.exe', '../Scan.jpg']) assert.throws(() => policy([entry(jpeg, name)]));
});

test('new profile bounds per-file, total bytes and count including older entries', () => {
  const rows = Array.from({ length: 64 }, (_, i) => ({ ...entry(jpeg), sha256: digest(String(i)), name: `Scan ${i}.jpg` }));
  assert.equal(policy(rows).documents.length, 64);
  assert.throws(() => policy([...rows, { ...rows[0], sha256: digest('extra') }]));
  assert.throws(() => policy([{ ...rows[0], size: SCAN_MAX_BYTES + 1 }]));
  assert.throws(() => policy(rows.slice(0, 13).map(row => ({ ...row, size: SCAN_MAX_BYTES }))));
});

test('manifest extension keeps previous entries immutable and deduplicates exact entries', () => {
  const original = entry(Buffer.from('%PDF-synthetic'), 'Original.pdf');
  const scan = entry(jpeg);
  assert.deepEqual(mergeManifest([original], [original, scan]), [original, scan]);
  assert.deepEqual(mergeManifest([original], []), [original]);
  for (const patch of [{ category: 'personal' }, { name: 'Renamed.pdf' }, { size: 999 }]) {
    assert.throws(() => mergeManifest([original], [{ ...original, ...patch }]), /EXISTING_ENTRY_CHANGED/);
  }
  assert.equal(mergeManifest([original], [scan])[0].sha256, original.sha256);
});

test('candidate size migration preserves original row and RLS without broadening table privileges', async () => {
  const db = new PGlite();
  try {
    await db.exec(readFileSync(require.resolve('../sql/ged-private-v1.sql'), 'utf8'));
    const hash = 'a'.repeat(64);
    await db.query('INSERT INTO ged_private.documents(tenant,owner_id,document_id,filename,byte_size,generation) VALUES($1,$1,$1,$2,20,$3)', [hash, 'Original.pdf', '1']);
    const before = (await db.query("SELECT relacl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ged_private.documents'::regclass")).rows;
    await db.exec(readFileSync(require.resolve('../sql/ged-scans-v3.sql'), 'utf8'));
    assert.deepEqual((await db.query("SELECT relacl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ged_private.documents'::regclass")).rows, before);
    assert.equal((await db.query('SELECT filename FROM ged_private.documents')).rows[0].filename, 'Original.pdf');
    await db.query('INSERT INTO ged_private.documents(tenant,owner_id,document_id,filename,byte_size,generation) VALUES($1,$1,$2,$3,$4,$5)', [hash, 'b'.repeat(64), 'Scan.jpg', SCAN_MAX_BYTES, '2']);
    await assert.rejects(db.query('INSERT INTO ged_private.documents(tenant,owner_id,document_id,filename,byte_size,generation) VALUES($1,$1,$2,$3,$4,$5)', [hash, 'c'.repeat(64), 'TooBig.jpg', SCAN_MAX_BYTES + 1, '3']));
  } finally { await db.close(); }
});

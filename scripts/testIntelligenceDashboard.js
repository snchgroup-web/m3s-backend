const assert = require('assert');
const {
  isPublishKeyValid,
  normalizePublication
} = require('../intelligenceDashboard');

const validPayload = {
  editionDate: '2026-08-07',
  generatedAt: '2026-08-07T06:30:00.000Z',
  sourceVersion: 'V4',
  html: '<!doctype html><html><body>2SG</body></html>',
  pdfBase64: Buffer.from('%PDF-1.4\n2SG').toString('base64'),
  reference: '# Référentiel 2SG'
};

const normalized = normalizePublication(validPayload);
assert.equal(normalized.editionDate, validPayload.editionDate);
assert.equal(normalized.generatedAt, validPayload.generatedAt);
assert.equal(normalized.htmlSha256.length, 64);
assert.equal(normalized.pdfSha256.length, 64);
assert.equal(normalized.referenceSha256.length, 64);

assert.equal(isPublishKeyValid('same-secret', 'same-secret'), true);
assert.equal(isPublishKeyValid('wrong-secret', 'same-secret'), false);
assert.equal(isPublishKeyValid('', 'same-secret'), false);

assert.throws(
  () => normalizePublication({ ...validPayload, editionDate: '07-08-2026' }),
  /YYYY-MM-DD/
);
assert.throws(
  () => normalizePublication({ ...validPayload, pdfBase64: Buffer.from('not-a-pdf').toString('base64') }),
  /PDF/
);

console.log('Intelligence Dashboard publication helpers: OK');

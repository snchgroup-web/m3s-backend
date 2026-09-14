const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  BOUSSOLE_ARTIFACT_PATH,
  createBoussoleArtifactHandler,
  loadBoussoleArtifact
} = require('../boussoleArtifact');

test('loads the trilingual Boussole from a server-side artifact', async () => {
  const content = await loadBoussoleArtifact();

  assert.equal(path.extname(BOUSSOLE_ARTIFACT_PATH), '.html');
  assert.match(content, /<html[\s>]/i);
  assert.match(content, /data-lang="FR"/);
  assert.match(content, /data-lang="DE"/);
  assert.match(content, /data-lang="EN"/);
});

test('rejects an invalid Boussole artifact', async () => {
  await assert.rejects(
    loadBoussoleArtifact(async () => '<html><body>Other document</body></html>'),
    { code: 'BOUSSOLE_ARTIFACT_INVALID' }
  );
});

test('serves the artifact with private no-store response headers', async () => {
  const response = {
    body: null,
    headers: {},
    selectedType: null,
    send(content) { this.body = content; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    type(value) { this.selectedType = value; return this; }
  };
  const handler = createBoussoleArtifactHandler({
    loadArtifact: async () => '<html><body>Boussole</body></html>'
  });

  await handler({}, response);

  assert.equal(response.selectedType, 'html');
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.body, '<html><body>Boussole</body></html>');
});

test('the HTTP route always requires authentication and forbids caching', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(
    server,
    /app\.get\('\/api\/boussole\/latest\/html', authenticateRequest, createBoussoleArtifactHandler\(\)\)/
  );
});

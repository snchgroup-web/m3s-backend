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

test('renders section and language changes without depending on blob hash navigation', async () => {
  const content = await loadBoussoleArtifact();

  assert.match(content, /nextHash=`#\$\{nextLang\.toLowerCase\(\)\}\/\$\{nextSection\}`/);
  assert.match(content, /lang=nextLang;current=nextSection;\$\('search'\)\.value='';render\(\)/);
  assert.match(content, /\$\('page-'\+current\)\.focus\(\);window\.scrollTo\(0,0\)/);
  assert.match(content, /try\{if\(location\.hash!==nextHash\)history\.pushState\(null,'',nextHash\)\}catch\(_\)\{\}/);
  assert.match(content, /window\.addEventListener\('hashchange',route\)/);
});

test('current published summary matches its source while old sections remain dated archives', async () => {
  const content = await loadBoussoleArtifact();
  const data = JSON.parse(content.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const current = require('../artifacts/programAccessCurrentStatus.json');
  assert.equal(data.version, '3.3');
  assert.equal(data.date, current.snapshotDate);
  assert.deepEqual(data.sections.find(section => section.id === current.id), current);
  assert.equal(data.sections.filter(section => section.id === current.id).length, 1);
  for (const lang of ['FR','DE','EN']) {
    assert.equal(data.ui[lang].factBody[0], current.intro[lang]);
    assert.equal(data.ui[lang].factBody[1], current.summary[lang]);
    assert.equal(data.ui[lang].factBody[2], current.nextStep[lang]);
  }
  assert.match(data.sections[0].blocks[0].title.FR, /13 septembre/);
  assert.doesNotMatch(JSON.stringify(current), /oobCode|AIza|BEGIN PRIVATE|8407|4673/);
});

test('temporarily clears an active search for native printing and restores it afterwards', async () => {
  const content = await loadBoussoleArtifact();

  assert.match(content, /if\(printedSearch===null\)printedSearch=\$\('search'\)\.value;\$\('search'\)\.value='';search\(\)/);
  assert.match(content, /\$\('search'\)\.value=printedSearch;printedSearch=null;search\(\)/);
  assert.match(content, /\$\('print'\)\.onclick=\(\)=>window\.print\(\)/);
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

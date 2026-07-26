const assert = require('assert');
const { createCorsOriginValidator } = require('../corsPolicy');

const validate = (origin) => new Promise((resolve) => {
  createCorsOriginValidator([
    'https://seneswiss-group.com',
    'http://localhost:3000'
  ])(origin, (error, allowed) => resolve({ error, allowed }));
});

const run = async () => {
  const cases = [
    [undefined, true],
    ['https://seneswiss-group.com', true],
    ['http://localhost:3000', true],
    ['https://deploy-preview-8--m3s-frontend-v2.netlify.app', true],
    ['https://deploy-preview-125--m3s-frontend-v2.netlify.app', true],
    ['https://deploy-preview-x--m3s-frontend-v2.netlify.app', false],
    ['https://deploy-preview-8--another-project.netlify.app', false],
    ['https://m3s-frontend-v2.netlify.app.evil.example', false],
    ['https://example.com', false]
  ];

  for (const [origin, expected] of cases) {
    const result = await validate(origin);
    assert.strictEqual(result.allowed, expected, origin || 'no origin');
    assert.strictEqual(Boolean(result.error), !expected, origin || 'no origin');
  }

  console.log(`CORS policy: ${cases.length}/${cases.length} cases passed`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

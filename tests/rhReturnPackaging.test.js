'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('return package is self contained and mounted before the private reader', () => {
  const root = path.resolve(__dirname, '..');
  const dir = path.join(root, 'rhReturns');
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.cjs') && !name.includes('.test.'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert(!/integration-rh-backend|viewer-rh-backend|outil-salaire/.test(source), file);
    assert.doesNotThrow(() => require(path.join(dir, file)), file);
  }
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert(source.indexOf('app.use(RH_PREFIX, rhReturnHost.router)') <
    source.indexOf('app.use(RH_PREFIX, rhReadHost.router)'));
  assert(source.includes('readBindings: rhReadHost.readBindings'));
});

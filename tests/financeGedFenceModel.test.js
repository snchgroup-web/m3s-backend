'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Model only: these transitions assume atomic compare-and-swap in the shared store.
function step(state, action) {
  const next = structuredClone(state);
  if (action === 'capture' && next.revision >= 0) {
    next.capture = { revision: next.revision, document: next.document };
  } else if (action === 'freeze' && next.revision >= 0) {
    next.revision = -next.revision - 1;
    next.freezeToken = next.revision;
  } else if (action === 'mutateDocument' && next.revision < 0) {
    next.document++;
  } else if (action === 'thaw' && next.revision < 0 && next.freezeToken === next.revision) {
    next.revision = -next.revision;
    next.freezeToken = null;
  } else if (action === 'write' && next.capture && next.revision >= 0 && next.revision === next.capture.revision) {
    next.writes.push({ checked: next.capture.document, committed: next.document });
    next.revision++;
  }
  return next;
}

const initial = () => ({ revision: 0, document: 0, capture: null, freezeToken: null, writes: [] });
const actions = ['capture', 'freeze', 'mutateDocument', 'thaw', 'write'];

test('fictional gate model rejects stale document checks across freeze and thaw', () => {
  let state = initial();
  for (const action of ['capture', 'freeze', 'mutateDocument', 'thaw', 'write']) state = step(state, action);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.writes, []);
});

test('fictional gate model remains closed after a crash before thaw', () => {
  let state = initial();
  for (const action of ['capture', 'freeze', 'mutateDocument', 'write']) state = step(state, action);
  assert.ok(state.revision < 0);
  assert.deepEqual(state.writes, []);
});

test('fictional gate model allows one write per captured revision', () => {
  let state = initial();
  for (const action of ['capture', 'write', 'write']) state = step(state, action);
  assert.deepEqual(state.writes, [{ checked: 0, committed: 0 }]);
});

test('fictional gate model preserves the invariant over bounded interleavings', () => {
  let states = [initial()];
  for (let depth = 0; depth < 7; depth++) {
    states = states.flatMap(state => actions.map(action => step(state, action)));
    for (const state of states) assert.ok(state.writes.every(write => write.checked === write.committed));
  }
});

'use strict';

const { createHmac } = require('node:crypto');

const FICTIONAL_TEST_KEY = 'fictional-cb1c-cursor-key-not-for-production';

function signature(payload) {
  return createHmac('sha256', FICTIONAL_TEST_KEY).update(payload).digest('base64url');
}

function createFakeAuthenticatedCursorCodec() {
  const encodeCalls = [];
  const decodeCalls = [];
  const payloads = new Map();
  let sequence = 0;
  const codec = Object.freeze({
    async encode(payload) {
      encodeCalls.push(structuredClone(payload));
      sequence += 1;
      const nonce = String(sequence);
      const token = `v1.${nonce}.${signature(`${nonce}:${JSON.stringify(payload)}`)}`;
      payloads.set(token, structuredClone(payload));
      return token;
    },
    async decode(token) {
      decodeCalls.push(token);
      if (!payloads.has(token)) throw new Error('Invalid fictional cursor');
      return structuredClone(payloads.get(token));
    }
  });
  return Object.freeze({ codec, encodeCalls, decodeCalls });
}

module.exports = { createFakeAuthenticatedCursorCodec };

'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const FICTIONAL_TEST_KEY = 'fictional-cb1c-cursor-key-not-for-production';

function signature(payload) {
  return createHmac('sha256', FICTIONAL_TEST_KEY).update(payload).digest('base64url');
}

function createFakeAuthenticatedCursorCodec() {
  const encodeCalls = [];
  const decodeCalls = [];
  const codec = Object.freeze({
    async encode(payload) {
      encodeCalls.push(structuredClone(payload));
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      return `${body}.${signature(body)}`;
    },
    async decode(token) {
      decodeCalls.push(token);
      const parts = token.split('.');
      if (parts.length !== 2) throw new Error('Invalid fictional cursor');
      const expected = Buffer.from(signature(parts[0]));
      const actual = Buffer.from(parts[1]);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new Error('Invalid fictional cursor signature');
      }
      return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    }
  });
  return Object.freeze({ codec, encodeCalls, decodeCalls });
}

module.exports = { createFakeAuthenticatedCursorCodec };

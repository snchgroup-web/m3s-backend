const crypto = require('node:crypto');
const { hasStrongSigningSecret } = require('../authConfiguration');

let secret;
do {
  secret = crypto.randomBytes(32).toString('base64url');
} while (!hasStrongSigningSecret(secret));

process.stdout.write(`${secret}\n`);

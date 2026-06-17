const crypto = require('crypto');

const [, , email, password, name = email, role = 'Utilisateur'] = process.argv;

if (!email || !password) {
  console.error('Usage: npm run auth:hash -- <email> <password> [name] [role]');
  process.exit(1);
}

const iterations = 120000;
const salt = crypto.randomBytes(16).toString('base64');
const passwordHash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64');

const user = {
  email,
  name,
  role,
  passwordHash,
  passwordSalt: salt,
  passwordIterations: iterations
};

console.log(JSON.stringify([user]));

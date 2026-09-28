'use strict';

// Usage: npm run create-admin -- <username> <email> [password]
// If no password is given a random one is generated and printed once.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { openDb } = require('../src/db');

const [username, email, givenPassword] = process.argv.slice(2);
if (!username || !email) {
  console.error('Usage: npm run create-admin -- <username> <email> [password]');
  process.exit(1);
}

const password = givenPassword || crypto.randomBytes(12).toString('base64url');
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const db = openDb(config.dbFile);
const hash = bcrypt.hashSync(password, config.bcryptRounds);
const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);

if (existing) {
  db.prepare("UPDATE users SET role = 'admin', password_hash = ?, banned = 0 WHERE id = ?").run(hash, existing.id);
  console.log(`Updated existing user "${username}" and made them an admin.`);
} else {
  db.prepare("INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
    .run(username, email, hash, Date.now());
  console.log(`Created admin "${username}".`);
}
if (!givenPassword) console.log(`Password: ${password}`);
db.close();

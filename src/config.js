'use strict';

const crypto = require('crypto');
const path = require('path');

const root = path.resolve(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) {
    throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
  }
  // Dev only: sessions are invalidated on every restart.
  sessionSecret = crypto.randomBytes(32).toString('hex');
}

module.exports = {
  root,
  isProd,
  port: Number(process.env.PORT) || 3000,
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'ctf.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'data', 'uploads'),
  sessionSecret,
  // Set TRUST_PROXY=1 when running behind nginx/Caddy so client IPs and secure cookies work.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
  maxUploadBytes: 50 * 1024 * 1024,
  bcryptRounds: 12,
};

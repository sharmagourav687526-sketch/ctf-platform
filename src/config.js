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

const port = Number(process.env.PORT) || 3000;

module.exports = {
  root,
  isProd,
  port,
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'ctf.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'data', 'uploads'),
  sessionSecret,
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
  maxUploadBytes: 50 * 1024 * 1024,
  bcryptRounds: 12,
  // Public URL used in outgoing emails and links (no trailing slash).
  appUrl: (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === '1',  // true for port 465
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@localhost',
  },
  captcha: {
    siteKey: process.env.TURNSTILE_SITE_KEY || '',
    secretKey: process.env.TURNSTILE_SECRET_KEY || '',
  },
  s3: {
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || '',   // for MinIO / Cloudflare R2
    publicUrl: process.env.S3_PUBLIC_URL || '', // CDN or bucket URL (no trailing slash)
  },
};

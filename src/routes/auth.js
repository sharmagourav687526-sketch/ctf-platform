'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { flash, requireLogin, verifyCaptcha } = require('../middleware');
const email = require('../services/email');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(pw) > 72) return 'Password is too long (72 bytes max).';
  return null;
}

// ── Per-account login lockout ──────────────────────────────────────────────
// In-memory: resets on server restart. Acceptable for single-instance.
const _failed = new Map(); // lowercased-username → { fails, lockedUntil }

function checkLocked(username) {
  const s = _failed.get(username.toLowerCase());
  if (!s || !s.lockedUntil) return null;
  return Date.now() < s.lockedUntil ? s.lockedUntil : null;
}

function recordFail(username) {
  const key = username.toLowerCase();
  const s = _failed.get(key) || { fails: 0, lockedUntil: null };
  s.fails += 1;
  if (s.fails >= config.login.maxFails) {
    s.lockedUntil = Date.now() + config.login.lockoutMs;
    s.fails = 0;
  }
  _failed.set(key, s);
}

function clearFails(username) {
  _failed.delete(username.toLowerCase());
}

// ── Token helpers ──────────────────────────────────────────────────────────

function createEmailToken(db, userId, type, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND type = ?').run(userId, type);
  db.prepare('INSERT INTO email_tokens (user_id, token, type, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, token, type, now + ttlMs, now);
  return token;
}

function consumeToken(db, token, type) {
  const row = db.prepare('SELECT * FROM email_tokens WHERE token = ? AND type = ? AND used = 0').get(token, type);
  if (!row) return null;
  if (Date.now() > row.expires_at) return null;
  db.prepare('UPDATE email_tokens SET used = 1 WHERE id = ?').run(row.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) || null;
}

// ── TOTP helpers ───────────────────────────────────────────────────────────

function getAuthenticator() {
  return require('otplib').authenticator;
}

function totpCheck(secret, token) {
  try {
    return getAuthenticator().check(String(token).replace(/\s/g, ''), secret);
  } catch {
    return false;
  }
}

module.exports = function authRoutes(db) {
  const router = express.Router();

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    handler: (req, res) => res.status(429).render('error', { title: 'Slow down', message: 'Too many attempts. Try again in a few minutes.' }),
  });

  // ── Register ────────────────────────────────────────────────────────────

  router.get('/register', (req, res) => {
    if (req.user) return res.redirect('/challenges');
    res.render('register', { title: 'Register', form: {}, error: null });
  });

  router.post('/register', authLimiter, verifyCaptcha, (req, res) => {
    if (req.settings.registration_open !== '1') {
      return res.status(403).render('register', { title: 'Register', form: {}, error: 'Registration is closed.' });
    }
    const form = { username: String(req.body.username || '').trim(), email: String(req.body.email || '').trim() };
    const password = req.body.password;
    const fail = (error) => res.status(400).render('register', { title: 'Register', form, error });

    if (!USERNAME_RE.test(form.username)) return fail('Username must be 3-24 characters: letters, numbers, . _ -');
    if (!EMAIL_RE.test(form.email) || form.email.length > 254) return fail('Enter a valid email address.');
    const pwError = validatePassword(password);
    if (pwError) return fail(pwError);
    if (password !== req.body.confirm) return fail('Passwords do not match.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(form.username, form.email)) {
      return fail('That username or email is already registered.');
    }

    const isFirst = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n === 0;
    const hash = bcrypt.hashSync(password, config.bcryptRounds);
    const emailVerified = email.isConfigured() && !isFirst ? 0 : 1;
    const info = db.prepare('INSERT INTO users (username, email, password_hash, role, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(form.username, form.email, hash, isFirst ? 'admin' : 'user', emailVerified, Date.now());

    req.session.regenerate(async (err) => {
      if (err) throw err;
      req.session.userId = info.lastInsertRowid;
      if (!emailVerified) {
        const token = createEmailToken(db, info.lastInsertRowid, 'verify', 24 * 60 * 60 * 1000);
        email.sendVerification(form.email, req.settings.ctf_name, token).catch(console.error);
        flash(req, 'info', 'Account created! Check your inbox to verify your email address.');
      } else {
        flash(req, 'success', isFirst ? 'Welcome! You are the first user, so you were made an admin.' : 'Account created. Good luck!');
      }
      res.redirect('/challenges');
    });
  });

  // ── Login ───────────────────────────────────────────────────────────────

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/challenges');
    res.render('login', { title: 'Login', error: null, name: '' });
  });

  router.post('/login', authLimiter, verifyCaptcha, (req, res) => {
    const name = String(req.body.name || '').trim();

    // Per-account lockout check.
    const lockedUntil = checkLocked(name);
    if (lockedUntil) {
      const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
      return res.status(429).render('login', { title: 'Login', error: `Account locked after too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`, name });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(name, name);
    const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
    const ok = bcrypt.compareSync(String(req.body.password || ''), hash) && user;

    if (!ok) {
      if (user) recordFail(user.username);
      return res.status(401).render('login', { title: 'Login', error: 'Invalid username or password.', name });
    }
    if (user.banned) return res.status(403).render('login', { title: 'Login', error: 'This account has been banned.', name });

    clearFails(user.username);

    // If TOTP is enabled, pause here and redirect to the verification step.
    if (user.totp_enabled && user.totp_secret) {
      const returnTo = req.session.returnTo;
      return req.session.regenerate((err) => {
        if (err) throw err;
        req.session.pendingTotpId = user.id;
        req.session.pendingTotpExpires = Date.now() + 5 * 60 * 1000;
        if (returnTo) req.session.returnTo = returnTo;
        res.redirect('/login/verify');
      });
    }

    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = user.id;
      res.redirect(typeof returnTo === 'string' && /^\/(?!\/)/.test(returnTo) ? returnTo : '/challenges');
    });
  });

  // ── TOTP verification (second factor) ───────────────────────────────────

  router.get('/login/verify', (req, res) => {
    if (!req.session.pendingTotpId || Date.now() > (req.session.pendingTotpExpires || 0)) {
      return res.redirect('/login');
    }
    res.render('login_totp', { title: 'Two-factor authentication', error: null });
  });

  router.post('/login/verify', authLimiter, (req, res) => {
    const userId = req.session.pendingTotpId;
    if (!userId || Date.now() > (req.session.pendingTotpExpires || 0)) {
      return res.redirect('/login');
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.totp_secret) {
      delete req.session.pendingTotpId;
      return res.redirect('/login');
    }
    if (!totpCheck(user.totp_secret, req.body.code)) {
      return res.render('login_totp', { title: 'Two-factor authentication', error: 'Invalid code. Try again.' });
    }
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = user.id;
      res.redirect(typeof returnTo === 'string' && /^\/(?!\/)/.test(returnTo) ? returnTo : '/challenges');
    });
  });

  // ── Logout ──────────────────────────────────────────────────────────────

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  // ── Email verification ───────────────────────────────────────────────────

  router.get('/verify-email', (req, res) => {
    const token = String(req.query.token || '');
    if (!token) return res.redirect('/');
    const user = consumeToken(db, token, 'verify');
    if (!user) {
      return res.render('verify_email', { title: 'Verify email', success: false, message: 'This verification link is invalid or has expired.' });
    }
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    res.render('verify_email', { title: 'Verify email', success: true, message: "Your email has been verified. You're all set!" });
  });

  router.post('/resend-verification', requireLogin, authLimiter, (req, res) => {
    if (req.user.email_verified) { flash(req, 'info', 'Your email is already verified.'); return res.redirect('/settings'); }
    if (!email.isConfigured()) { flash(req, 'error', 'Email is not configured on this platform.'); return res.redirect('/settings'); }
    const token = createEmailToken(db, req.user.id, 'verify', 24 * 60 * 60 * 1000);
    email.sendVerification(req.user.email, req.settings.ctf_name, token).catch(console.error);
    flash(req, 'success', 'Verification email sent. Check your inbox.');
    res.redirect('/settings');
  });

  // ── Forgot / reset password ──────────────────────────────────────────────

  router.get('/forgot-password', (req, res) => {
    if (req.user) return res.redirect('/settings');
    res.render('forgot_password', { title: 'Forgot password', sent: false, error: null });
  });

  router.post('/forgot-password', authLimiter, (req, res) => {
    const addr = String(req.body.email || '').trim().toLowerCase();
    const done = () => res.render('forgot_password', { title: 'Forgot password', sent: true, error: null });
    if (!email.isConfigured()) {
      return res.render('forgot_password', { title: 'Forgot password', sent: false, error: 'Email is not configured. Ask an admin to reset your password.' });
    }
    if (!EMAIL_RE.test(addr)) return done();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(addr);
    if (user && !user.banned) {
      const token = createEmailToken(db, user.id, 'reset', 60 * 60 * 1000);
      email.sendPasswordReset(user.email, req.settings.ctf_name, token).catch(console.error);
    }
    done();
  });

  router.get('/reset-password', (req, res) => {
    const token = String(req.query.token || '');
    const row = db.prepare('SELECT * FROM email_tokens WHERE token = ? AND type = ? AND used = 0').get(token, 'reset');
    if (!row || Date.now() > row.expires_at) {
      return res.render('reset_password', { title: 'Reset password', valid: false, token: '', error: null });
    }
    res.render('reset_password', { title: 'Reset password', valid: true, token, error: null });
  });

  router.post('/reset-password', authLimiter, (req, res) => {
    const token = String(req.body.token || '');
    const user = consumeToken(db, token, 'reset');
    if (!user) return res.render('reset_password', { title: 'Reset password', valid: false, token: '', error: null });
    const pwError = validatePassword(req.body.password);
    if (pwError) return res.render('reset_password', { title: 'Reset password', valid: true, token, error: pwError });
    if (req.body.password !== req.body.confirm) return res.render('reset_password', { title: 'Reset password', valid: true, token, error: 'Passwords do not match.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, config.bcryptRounds), user.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(user.id);
    flash(req, 'success', 'Password reset. You can now log in with your new password.');
    res.redirect('/login');
  });

  // ── Settings (profile + password change) ────────────────────────────────

  router.get('/settings', requireLogin, (req, res) => {
    res.render('settings', { title: 'Settings', error: null });
  });

  router.post('/settings', requireLogin, authLimiter, (req, res) => {
    const country = String(req.body.country || '').trim().slice(0, 2).toUpperCase() || null;
    if (req.body.new_password) {
      if (!bcrypt.compareSync(String(req.body.current_password || ''), req.user.password_hash)) {
        return res.status(400).render('settings', { title: 'Settings', error: 'Current password is incorrect.' });
      }
      const pwError = validatePassword(req.body.new_password);
      if (pwError) return res.status(400).render('settings', { title: 'Settings', error: pwError });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.new_password, config.bcryptRounds), req.user.id);
    }
    db.prepare('UPDATE users SET country = ? WHERE id = ?').run(country, req.user.id);
    flash(req, 'success', 'Settings saved.');
    res.redirect('/settings');
  });

  // ── 2FA setup ────────────────────────────────────────────────────────────

  router.get('/settings/2fa/setup', requireLogin, async (req, res, next) => {
    try {
      const auth = getAuthenticator();
      const secret = auth.generateSecret();
      req.session.pendingTotpSecret = secret;
      const otpauthUrl = auth.keyuri(req.user.username, req.settings.ctf_name, secret);
      const qrDataUrl = await qrcode.toDataURL(otpauthUrl);
      res.render('settings_2fa', { title: 'Enable two-factor auth', secret, qrDataUrl, error: null });
    } catch (e) { next(e); }
  });

  router.post('/settings/2fa/enable', requireLogin, authLimiter, async (req, res, next) => {
    try {
      const secret = req.session.pendingTotpSecret;
      if (!secret) return res.redirect('/settings/2fa/setup');
      if (!totpCheck(secret, req.body.code)) {
        const auth = getAuthenticator();
        const otpauthUrl = auth.keyuri(req.user.username, req.settings.ctf_name, secret);
        const qrDataUrl = await qrcode.toDataURL(otpauthUrl);
        return res.render('settings_2fa', { title: 'Enable two-factor auth', secret, qrDataUrl, error: 'Invalid code — try again.' });
      }
      delete req.session.pendingTotpSecret;
      db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, req.user.id);
      flash(req, 'success', 'Two-factor authentication is now enabled.');
      res.redirect('/settings');
    } catch (e) { next(e); }
  });

  router.post('/settings/2fa/disable', requireLogin, authLimiter, (req, res) => {
    if (!bcrypt.compareSync(String(req.body.password || ''), req.user.password_hash)) {
      return res.status(400).render('settings', { title: 'Settings', error: 'Current password is incorrect.' });
    }
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(req.user.id);
    flash(req, 'success', 'Two-factor authentication disabled.');
    res.redirect('/settings');
  });

  return router;
};

module.exports.validatePassword = validatePassword;

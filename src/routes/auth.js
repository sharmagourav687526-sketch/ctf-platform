'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { flash, requireLogin } = require('../middleware');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(pw) > 72) return 'Password is too long (72 bytes max).';
  return null;
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

  router.get('/register', (req, res) => {
    if (req.user) return res.redirect('/challenges');
    res.render('register', { title: 'Register', form: {}, error: null });
  });

  router.post('/register', authLimiter, (req, res) => {
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

    // The first account on a fresh install becomes the admin.
    const isFirst = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n === 0;
    const hash = bcrypt.hashSync(password, config.bcryptRounds);
    const info = db.prepare('INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(form.username, form.email, hash, isFirst ? 'admin' : 'user', Date.now());

    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = info.lastInsertRowid;
      flash(req, 'success', isFirst ? 'Welcome! You are the first user, so you were made an admin.' : 'Account created. Good luck!');
      res.redirect('/challenges');
    });
  });

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/challenges');
    res.render('login', { title: 'Login', error: null, name: '' });
  });

  router.post('/login', authLimiter, (req, res) => {
    const name = String(req.body.name || '').trim();
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(name, name);
    // Always run bcrypt so response time doesn't reveal whether the account exists.
    const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
    const ok = bcrypt.compareSync(String(req.body.password || ''), hash) && user;
    if (!ok) return res.status(401).render('login', { title: 'Login', error: 'Invalid username or password.', name });
    if (user.banned) return res.status(403).render('login', { title: 'Login', error: 'This account has been banned.', name });

    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = user.id;
      // Only allow same-site relative redirects.
      res.redirect(typeof returnTo === 'string' && /^\/(?!\/)/.test(returnTo) ? returnTo : '/challenges');
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

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

  return router;
};

module.exports.validatePassword = validatePassword;

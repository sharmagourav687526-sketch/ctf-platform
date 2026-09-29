'use strict';

const crypto = require('crypto');
const { getSettings } = require('./db');
const { eventState } = require('./services/ctf');
const config = require('./config');

/** Load the logged-in user, site settings and CSRF token for every request. */
function context(db) {
  return (req, res, next) => {
    const settings = getSettings(db);
    let user = null;
    if (req.session.userId) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
      if (!user || user.banned) {
        user = null;
        delete req.session.userId;
      }
    }
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    req.user = user;
    req.settings = settings;
    res.locals.user = user;
    res.locals.settings = settings;
    res.locals.event = eventState(settings);
    res.locals.csrfToken = req.session.csrf;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.path = req.path;
    next();
  };
}

/** Reject state-changing requests that don't carry the session's CSRF token. */
function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || req.query._csrf;
  const expected = req.session.csrf;
  const ok = typeof sent === 'string' && expected && sent.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return res.status(403).render('error', { title: 'Forbidden', message: 'Invalid or missing CSRF token. Reload the page and try again.' });
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin only' });
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
}

/** Admin or monitor — allows read-only staff access to the admin panel. */
function requireStaff(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'monitor')) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Staff only' });
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
}

/** Block monitors from any state-changing request. */
function monitorReadOnly(req, res, next) {
  if (req.user && req.user.role === 'monitor' && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Monitors have read-only access. Ask an admin to make changes.' });
  }
  next();
}

function flash(req, type, text) {
  req.session.flash = { type, text };
}

/**
 * Cloudflare Turnstile CAPTCHA verification. No-op if TURNSTILE_SECRET_KEY is not set.
 * Fails open if Cloudflare is unreachable — better for a competition than locking out players.
 */
async function verifyCaptcha(req, res, next) {
  if (!config.captcha.secretKey) return next();
  const token = req.body['cf-turnstile-response'];
  if (!token) {
    return res.status(400).render('error', { title: 'Forbidden', message: 'CAPTCHA verification required. Please reload the page and try again.' });
  }
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.captcha.secretKey, response: token, remoteip: req.ip }),
    });
    const data = await resp.json();
    if (!data.success) {
      return res.status(400).render('error', { title: 'Forbidden', message: 'CAPTCHA check failed. Please reload the page and try again.' });
    }
  } catch {
    // Fail open so a Cloudflare outage doesn't lock out participants.
  }
  next();
}

module.exports = { context, csrf, requireLogin, requireAdmin, requireStaff, monitorReadOnly, flash, verifyCaptcha };

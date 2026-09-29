'use strict';

const express = require('express');
const ctf = require('../services/ctf');
const { requireLogin } = require('../middleware');
const { renderMarkdown } = require('../utils');
const storage = require('../services/storage');

module.exports = function challengeRoutes(db, config) {
  const router = express.Router();

  // Before the CTF starts, players (not admins) can't see or fetch challenges.
  function gate(req, res, next) {
    if (req.user.role !== 'admin' && !res.locals.event.started) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'The CTF has not started yet.' });
      return res.render('challenges', { title: 'Challenges', notStarted: true });
    }
    next();
  }

  router.get('/challenges', requireLogin, gate, (req, res) => {
    res.render('challenges', { title: 'Challenges', notStarted: false });
  });

  router.get('/api/challenges', requireLogin, gate, (req, res) => {
    res.json(ctf.listChallenges(db, req.settings.mode, req.user));
  });

  router.get('/api/challenges/:id', requireLogin, gate, (req, res) => {
    const challenge = ctf.getChallenge(db, req.settings.mode, req.user, Number(req.params.id));
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    // The client injects this HTML directly; renderMarkdown escapes everything first.
    res.json({ ...challenge, description_html: renderMarkdown(challenge.description) });
  });

  router.post('/api/challenges/:id/attempt', requireLogin, gate, (req, res) => {
    const result = ctf.submitFlag(db, {
      settings: req.settings,
      user: req.user,
      challengeId: Number(req.params.id),
      provided: req.body.flag,
      ip: req.ip,
    });
    const code = { ratelimited: 429, not_found: 404 }[result.status] || 200;
    res.status(code).json(result);
  });

  router.post('/api/hints/:id/unlock', requireLogin, gate, (req, res) => {
    const result = ctf.unlockHint(db, { settings: req.settings, user: req.user, hintId: Number(req.params.id) });
    res.status(result.status === 'ok' ? 200 : result.status === 'not_found' ? 404 : 403).json(result);
  });

  // ---------- Writeups ----------

  function getWriteups(challengeId, userId) {
    return db.prepare(`
      SELECT w.id, w.user_id, u.username, w.url, w.created_at
      FROM writeups w JOIN users u ON u.id = w.user_id
      WHERE w.challenge_id = ? ORDER BY w.created_at ASC
    `).all(challengeId).map((w) => ({ ...w, is_mine: w.user_id === userId }));
  }

  router.get('/api/challenges/:id/writeups', requireLogin, gate, (req, res) => {
    const ch = db.prepare('SELECT id FROM challenges WHERE id = ? AND visible = 1').get(Number(req.params.id));
    if (!ch) return res.status(404).json({ error: 'Not found' });
    res.json(getWriteups(ch.id, req.user.id));
  });

  router.post('/api/challenges/:id/writeup', requireLogin, gate, (req, res) => {
    const challengeId = Number(req.params.id);
    const ch = db.prepare('SELECT id FROM challenges WHERE id = ? AND visible = 1').get(challengeId);
    if (!ch) return res.status(404).json({ error: 'Not found' });

    const solved = db.prepare('SELECT 1 FROM solves WHERE challenge_id = ? AND user_id = ?').get(challengeId, req.user.id);
    if (!solved) return res.status(403).json({ error: 'Solve this challenge first.' });

    const url = String(req.body.url || '').trim().slice(0, 500);
    if (!url) return res.status(400).json({ error: 'URL is required.' });
    if (!/^https?:\/\/.{3,}/.test(url)) return res.status(400).json({ error: 'URL must start with http:// or https://' });

    db.prepare(`
      INSERT INTO writeups (challenge_id, user_id, url, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(challenge_id, user_id) DO UPDATE SET url = excluded.url
    `).run(challengeId, req.user.id, url, Date.now());

    res.json({ ok: true, writeups: getWriteups(challengeId, req.user.id) });
  });

  router.delete('/api/writeups/:id', requireLogin, (req, res) => {
    const w = db.prepare('SELECT * FROM writeups WHERE id = ?').get(Number(req.params.id));
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    db.prepare('DELETE FROM writeups WHERE id = ?').run(w.id);
    res.json({ ok: true });
  });

  router.get('/files/:id', requireLogin, gate, (req, res) => {
    const file = db.prepare('SELECT f.* FROM files f JOIN challenges c ON c.id = f.challenge_id WHERE f.id = ? AND c.visible = 1').get(Number(req.params.id));
    if (!file) return res.status(404).render('error', { title: 'Not found', message: 'File not found.' });
    storage.serveFile(res, file.stored_name, file.filename);
  });

  return router;
};

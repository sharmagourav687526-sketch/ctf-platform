'use strict';

const path = require('path');
const express = require('express');
const ctf = require('../services/ctf');
const { requireLogin } = require('../middleware');
const { renderMarkdown } = require('../utils');

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

  router.get('/files/:id', requireLogin, gate, (req, res) => {
    const file = db.prepare('SELECT f.* FROM files f JOIN challenges c ON c.id = f.challenge_id WHERE f.id = ? AND c.visible = 1').get(Number(req.params.id));
    if (!file) return res.status(404).render('error', { title: 'Not found', message: 'File not found.' });
    // stored_name is generated server-side (hex), never user input, so it cannot escape uploadDir.
    res.download(path.join(config.uploadDir, file.stored_name), file.filename);
  });

  return router;
};

'use strict';

const express = require('express');
const { computeScoreboard, challengeValue, solveCounts } = require('../scoring');
const { recentActivity, siteStats } = require('../services/activity');
const { flash, requireLogin } = require('../middleware');
const { randomHex } = require('../utils');

const TEAM_NAME_RE = /^[\w .'-]{3,32}$/;

module.exports = function scoreboardRoutes(db) {
  const router = express.Router();

  // The scoreboard is private if the admin turned off public viewing (admins always see it).
  function canView(req, res, next) {
    if (req.settings.scoreboard_public === '1' || (req.user && req.user.role === 'admin')) return next();
    if (!req.user) return res.redirect('/login');
    next();
  }

  router.get('/', (req, res) => {
    const announcements = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 3').all();
    const showBoard = req.settings.scoreboard_public === '1' || !!req.user;
    res.render('index', {
      title: null,
      announcements,
      stats: siteStats(db, req.settings.mode),
      categories: db.prepare('SELECT DISTINCT category FROM challenges WHERE visible = 1 ORDER BY category').all().map((r) => r.category),
      top: showBoard ? computeScoreboard(db, req.settings.mode).standings.slice(0, 5) : [],
      showBoard,
      activity: showBoard ? recentActivity(db, req.settings.mode, { limit: 8 }) : [],
    });
  });

  // Live solve feed. `since` lets the browser fetch only what's new (used for toast notifications).
  router.get('/api/activity', canView, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(recentActivity(db, req.settings.mode, {
      limit: Math.min(50, Number(req.query.limit) || 20),
      sinceId: Number(req.query.since) || 0,
    }));
  });

  router.get('/announcements', (req, res) => {
    const items = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100').all();
    res.render('announcements', { title: 'Announcements', items });
  });

  router.get('/api/announcements', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(db.prepare('SELECT id, title, created_at FROM announcements ORDER BY created_at DESC LIMIT 10').all());
  });

  router.get('/scoreboard', canView, (req, res) => {
    res.render('scoreboard', { title: 'Scoreboard' });
  });

  router.get('/api/scoreboard', canView, (req, res) => {
    const { standings, timelines } = computeScoreboard(db, req.settings.mode);
    res.set('Cache-Control', 'no-store');
    res.json({
      mode: req.settings.mode,
      standings: standings.slice(0, 200).map((o) => ({ rank: o.rank, type: o.type, id: o.id, name: o.name, score: o.score, solves: o.solves })),
      series: standings.slice(0, 10).map((o) => ({ name: o.name, points: timelines.get(`${o.type}:${o.id}`) })),
    });
  });

  function solveHistory(where, param) {
    const counts = solveCounts(db);
    return db.prepare(`
      SELECT s.created_at, c.*, u.username AS solver
      FROM solves s JOIN challenges c ON c.id = s.challenge_id JOIN users u ON u.id = s.user_id
      WHERE ${where} ORDER BY s.created_at DESC`).all(param)
      .map((r) => ({ name: r.name, category: r.category, value: challengeValue(r, counts.get(r.id) || 0), at: r.created_at, solver: r.solver }));
  }

  router.get('/users/:id', canView, (req, res) => {
    const profile = db.prepare('SELECT id, username, country, team_id, created_at FROM users WHERE id = ? AND hidden = 0 AND banned = 0').get(Number(req.params.id));
    if (!profile) return res.status(404).render('error', { title: 'Not found', message: 'User not found.' });
    const team = profile.team_id ? db.prepare('SELECT id, name FROM teams WHERE id = ? AND hidden = 0').get(profile.team_id) : null;
    const solves = solveHistory('s.user_id = ?', profile.id);
    res.render('profile', { title: profile.username, kind: 'user', profile, team, members: [], solves, total: solves.reduce((n, s) => n + s.value, 0) });
  });

  router.get('/teams/:id', canView, (req, res) => {
    const profile = db.prepare('SELECT id, name, created_at FROM teams WHERE id = ? AND hidden = 0 AND banned = 0').get(Number(req.params.id));
    if (!profile) return res.status(404).render('error', { title: 'Not found', message: 'Team not found.' });
    const members = db.prepare('SELECT id, username FROM users WHERE team_id = ? AND hidden = 0 AND banned = 0 ORDER BY username').all(profile.id);
    const solves = solveHistory('s.team_id = ?', profile.id);
    res.render('profile', { title: profile.name, kind: 'team', profile, team: null, members, solves, total: solves.reduce((n, s) => n + s.value, 0) });
  });

  // ---- Team management (only meaningful in team mode) ----
  function teamsOnly(req, res, next) {
    if (req.settings.mode !== 'teams') return res.redirect('/challenges');
    next();
  }

  router.get('/team', requireLogin, teamsOnly, (req, res) => {
    const team = req.user.team_id ? db.prepare('SELECT * FROM teams WHERE id = ?').get(req.user.team_id) : null;
    const members = team ? db.prepare('SELECT id, username FROM users WHERE team_id = ? ORDER BY created_at').all(team.id) : [];
    res.render('team', { title: 'My team', team, members, error: null });
  });

  router.post('/team/create', requireLogin, teamsOnly, (req, res) => {
    const name = String(req.body.name || '').trim();
    const fail = (error) => res.status(400).render('team', { title: 'My team', team: null, members: [], error });
    if (req.user.team_id) return fail('You are already on a team.');
    if (!TEAM_NAME_RE.test(name)) return fail('Team name must be 3-32 characters (letters, numbers, spaces, . _ \' -).');
    if (db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name)) return fail('That team name is taken.');
    db.transaction(() => {
      const info = db.prepare('INSERT INTO teams (name, invite_code, captain_id, created_at) VALUES (?, ?, ?, ?)')
        .run(name, randomHex(8), req.user.id, Date.now());
      db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(info.lastInsertRowid, req.user.id);
    })();
    flash(req, 'success', 'Team created. Share the invite code with your teammates.');
    res.redirect('/team');
  });

  router.post('/team/join', requireLogin, teamsOnly, (req, res) => {
    const fail = (error) => res.status(400).render('team', { title: 'My team', team: null, members: [], error });
    if (req.user.team_id) return fail('You are already on a team.');
    const team = db.prepare('SELECT * FROM teams WHERE invite_code = ? AND banned = 0').get(String(req.body.code || '').trim());
    if (!team) return fail('Invalid invite code.');
    const size = db.prepare('SELECT COUNT(*) AS n FROM users WHERE team_id = ?').get(team.id).n;
    if (size >= Number(req.settings.team_size)) return fail('That team is full.');
    db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(team.id, req.user.id);
    flash(req, 'success', `You joined ${team.name}.`);
    res.redirect('/team');
  });

  router.post('/team/leave', requireLogin, teamsOnly, (req, res) => {
    const teamId = req.user.team_id;
    if (!teamId) return res.redirect('/team');
    db.transaction(() => {
      db.prepare('UPDATE users SET team_id = NULL WHERE id = ?').run(req.user.id);
      const next = db.prepare('SELECT id FROM users WHERE team_id = ? ORDER BY created_at LIMIT 1').get(teamId);
      if (!next) db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      else db.prepare('UPDATE teams SET captain_id = ? WHERE id = ? AND captain_id = ?').run(next.id, teamId, req.user.id);
    })();
    flash(req, 'success', 'You left the team.');
    res.redirect('/team');
  });

  return router;
};

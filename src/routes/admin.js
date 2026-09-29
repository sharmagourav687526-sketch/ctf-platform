'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { setSetting } = require('../db');
const { requireLogin, requireAdmin, requireStaff, monitorReadOnly, flash } = require('../middleware');
const { computeScoreboard, challengeValue, solveCounts } = require('../scoring');
const { toCsv, parseEpoch, renderMarkdown } = require('../utils');
const { validatePassword } = require('./auth');
const storage = require('../services/storage');
const scoreCache = require('../scoreboardCache');
const audit = require('../services/audit');
const discord = require('../services/discord');

const PAGE_SIZE = 50;
const MAX_FILES_PER_UPLOAD = 10;

function int(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = function adminRoutes(db, config) {
  const router = express.Router();
  router.use(requireLogin, requireStaff, monitorReadOnly);

  const upload = multer({
    storage: storage.makeMulterStorage(multer),
    limits: { fileSize: config.maxUploadBytes, files: MAX_FILES_PER_UPLOAD },
  });

  // Register uploaded files against a challenge. stored_name is random hex (disk) or S3 key.
  function storeFiles(challengeId, files) {
    const insert = db.prepare('INSERT INTO files (challenge_id, filename, stored_name, size) VALUES (?, ?, ?, ?)');
    for (const f of files || []) {
      const filename = path.basename(f.originalname).replace(/[\x00-\x1f"\\/]/g, '_').slice(0, 200) || 'file';
      insert.run(challengeId, filename, storage.storedNameOf(f), f.size);
    }
  }

  // Redirect to the admin page the action came from, never to an arbitrary external URL.
  function back(req, res, fallback) {
    try {
      const url = new URL(req.get('referer') || '', 'http://localhost');
      if (url.pathname.startsWith('/admin')) return res.redirect(url.pathname + url.search);
    } catch { /* malformed referer: use the fallback */ }
    return res.redirect(fallback);
  }

  // ---------- Dashboard ----------
  router.get('/', (req, res) => {
    const count = (sql) => db.prepare(sql).get().n;
    const stats = {
      users: count('SELECT COUNT(*) AS n FROM users'),
      teams: count('SELECT COUNT(*) AS n FROM teams'),
      challenges: count('SELECT COUNT(*) AS n FROM challenges'),
      solves: count('SELECT COUNT(*) AS n FROM solves'),
      submissions: count('SELECT COUNT(*) AS n FROM submissions'),
      correct: count('SELECT COUNT(*) AS n FROM submissions WHERE correct = 1'),
    };
    const recent = db.prepare(`
      SELECT s.*, u.username, c.name AS challenge FROM submissions s
      JOIN users u ON u.id = s.user_id JOIN challenges c ON c.id = s.challenge_id
      ORDER BY s.created_at DESC LIMIT 10`).all();
    res.render('admin/dashboard', { title: 'Admin', stats, recent });
  });

  // ---------- Challenges ----------
  router.get('/challenges', (req, res) => {
    const counts = solveCounts(db);
    const challenges = db.prepare('SELECT * FROM challenges ORDER BY category, points, id').all()
      .map((c) => ({ ...c, value: challengeValue(c, counts.get(c.id) || 0), solves: counts.get(c.id) || 0 }));
    res.render('admin/challenges', { title: 'Challenges', challenges });
  });

  function parseChallenge(body, selfId) {
    const errors = [];
    const name = String(body.name || '').trim().slice(0, 100);
    const category = String(body.category || '').trim().slice(0, 50);
    if (!name) errors.push('Name is required.');
    if (!category) errors.push('Category is required.');
    const points = int(body.points, 0, 100000, 100);
    let minPoints = int(body.min_points, 0, 100000, points);
    const decay = int(body.decay, 0, 100000, 0);
    if (decay > 0 && minPoints > points) { errors.push('Minimum points cannot exceed initial points.'); minPoints = points; }
    if (decay === 0) minPoints = points;
    let requiresId = body.requires_id ? int(body.requires_id, 1, Number.MAX_SAFE_INTEGER, null) : null;
    if (requiresId && (requiresId === selfId || !db.prepare('SELECT 1 FROM challenges WHERE id = ?').get(requiresId))) {
      errors.push('Prerequisite challenge does not exist.');
      requiresId = null;
    }
    const releaseTime = parseEpoch(body.release_time);
    if (releaseTime === null) errors.push('Invalid release time.');
    return {
      errors,
      values: {
        name, category,
        description: String(body.description || '').slice(0, 20000),
        connection_info: String(body.connection_info || '').trim().slice(0, 500),
        points, min_points: minPoints, decay,
        max_attempts: int(body.max_attempts, 0, 1000, 0),
        visible: body.visible === '1' ? 1 : 0,
        requires_id: requiresId,
        release_time: releaseTime === '' ? null : Number(releaseTime) || null,
      },
    };
  }

  router.get('/challenges/new', (req, res) => {
    res.render('admin/challenge_form', {
      title: 'New challenge', challenge: null, flags: [], hints: [], files: [], others: db.prepare('SELECT id, name FROM challenges ORDER BY name').all(), errors: [],
    });
  });

  // Multipart form: the CSRF token travels in the query string because the body isn't parsed yet.
  router.post('/challenges', upload.array('files', MAX_FILES_PER_UPLOAD), (req, res) => {
    const { errors, values } = parseChallenge(req.body, null);
    const flagContent = String(req.body.flag || '').trim();
    if (!flagContent) errors.push('At least one flag is required.');
    if (errors.length) {
      storage.discardFiles(req.files);
      return res.status(400).render('admin/challenge_form', {
        title: 'New challenge', challenge: values, flags: [], hints: [], files: [], others: db.prepare('SELECT id, name FROM challenges ORDER BY name').all(), errors,
      });
    }
    const id = db.transaction(() => {
      const info = db.prepare(`INSERT INTO challenges (name, category, description, connection_info, points, min_points, decay, max_attempts, visible, requires_id, release_time, created_at)
        VALUES (@name, @category, @description, @connection_info, @points, @min_points, @decay, @max_attempts, @visible, @requires_id, @release_time, @created_at)`)
        .run({ ...values, created_at: Date.now() });
      const flagType = ['static', 'regex', 'dynamic'].includes(req.body.flag_type) ? req.body.flag_type : 'static';
      db.prepare('INSERT INTO flags (challenge_id, content, type, case_sensitive) VALUES (?, ?, ?, ?)')
        .run(info.lastInsertRowid, flagContent, flagType, req.body.case_insensitive === '1' ? 0 : 1);
      const hint = String(req.body.hint || '').trim().slice(0, 2000);
      if (hint) db.prepare('INSERT INTO hints (challenge_id, content, cost) VALUES (?, ?, ?)').run(info.lastInsertRowid, hint, int(req.body.hint_cost, 0, 100000, 0));
      storeFiles(info.lastInsertRowid, req.files);
      return info.lastInsertRowid;
    })();
    audit.log(db, req, 'challenge.create', values.name, `category=${values.category} points=${values.points}`);
    flash(req, 'success', 'Challenge created.');
    res.redirect(`/admin/challenges/${id}/edit`);
  });

  // Challenge JSON import (textarea paste) — must be BEFORE /:id routes.
  router.get('/challenges/import', requireAdmin, (req, res) => {
    res.render('admin/challenge_import', { title: 'Import challenges', errors: [], imported: null });
  });

  router.post('/challenges/import', requireAdmin, (req, res) => {
    const raw = String(req.body.data || '').trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return res.status(400).render('admin/challenge_import', { title: 'Import challenges', errors: ['Invalid JSON.'], imported: null }); }
    if (!Array.isArray(parsed)) return res.status(400).render('admin/challenge_import', { title: 'Import challenges', errors: ['Expected a JSON array of challenges.'], imported: null });
    let count = 0;
    db.transaction(() => {
      for (const c of parsed) {
        const name = String(c.name || '').trim().slice(0, 100);
        const category = String(c.category || '').trim().slice(0, 50);
        if (!name || !category) continue;
        const flags = Array.isArray(c.flags) ? c.flags.filter((f) => f && String(f.content || '').trim()) : [];
        if (!flags.length) continue;
        const info = db.prepare(`INSERT INTO challenges (name, category, description, connection_info, points, min_points, decay, max_attempts, visible, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
          .run(name, category, String(c.description || ''), String(c.connection_info || '').slice(0, 500),
            int(c.points, 0, 100000, 100), int(c.min_points, 0, 100000, int(c.points, 0, 100000, 100)),
            int(c.decay, 0, 100000, 0), int(c.max_attempts, 0, 1000, 0), Date.now());
        const cid = info.lastInsertRowid;
        for (const f of flags) {
          const ftype = ['static', 'regex', 'dynamic'].includes(f.type) ? f.type : 'static';
          db.prepare('INSERT INTO flags (challenge_id, content, type, case_sensitive) VALUES (?, ?, ?, ?)')
            .run(cid, String(f.content).trim(), ftype, f.case_sensitive ? 1 : 0);
        }
        for (const h of (Array.isArray(c.hints) ? c.hints : [])) {
          const hcontent = String(h.content || '').trim().slice(0, 2000);
          if (hcontent) db.prepare('INSERT INTO hints (challenge_id, content, cost) VALUES (?, ?, ?)').run(cid, hcontent, int(h.cost, 0, 100000, 0));
        }
        count += 1;
      }
    })();
    audit.log(db, req, 'challenge.import', '', `count=${count}`);
    scoreCache.invalidate();
    res.render('admin/challenge_import', { title: 'Import challenges', errors: [], imported: count });
  });

  function loadChallenge(id) {
    const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
    if (!challenge) return null;
    return {
      challenge,
      flags: db.prepare('SELECT * FROM flags WHERE challenge_id = ?').all(id),
      hints: db.prepare('SELECT * FROM hints WHERE challenge_id = ? ORDER BY id').all(id),
      files: db.prepare('SELECT * FROM files WHERE challenge_id = ?').all(id),
      others: db.prepare('SELECT id, name FROM challenges WHERE id != ? ORDER BY name').all(id),
    };
  }

  router.get('/challenges/:id/edit', (req, res) => {
    const data = loadChallenge(Number(req.params.id));
    if (!data) return res.status(404).render('error', { title: 'Not found', message: 'Challenge not found.' });
    res.render('admin/challenge_form', { title: `Edit ${data.challenge.name}`, ...data, errors: [] });
  });

  router.post('/challenges/:id', (req, res) => {
    const id = Number(req.params.id);
    const data = loadChallenge(id);
    if (!data) return res.status(404).render('error', { title: 'Not found', message: 'Challenge not found.' });
    const { errors, values } = parseChallenge(req.body, id);
    if (errors.length) {
      return res.status(400).render('admin/challenge_form', { title: `Edit ${data.challenge.name}`, ...data, challenge: { ...data.challenge, ...values }, errors });
    }
    db.prepare(`UPDATE challenges SET name=@name, category=@category, description=@description, connection_info=@connection_info,
      points=@points, min_points=@min_points, decay=@decay, max_attempts=@max_attempts, visible=@visible, requires_id=@requires_id, release_time=@release_time WHERE id=@id`)
      .run({ ...values, id });
    audit.log(db, req, 'challenge.edit', values.name, `id=${id} visible=${values.visible}`);
    flash(req, 'success', 'Challenge saved.');
    res.redirect(`/admin/challenges/${id}/edit`);
  });

  router.post('/challenges/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const ch = db.prepare('SELECT name FROM challenges WHERE id = ?').get(id);
    const files = db.prepare('SELECT stored_name FROM files WHERE challenge_id = ?').all(id);
    db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
    for (const f of files) storage.deleteFile(f.stored_name);
    if (ch) audit.log(db, req, 'challenge.delete', ch.name, `id=${id}`);
    flash(req, 'success', 'Challenge deleted.');
    res.redirect('/admin/challenges');
  });

  router.post('/challenges/:id/flags', (req, res) => {
    const content = String(req.body.content || '').trim().slice(0, 500);
    if (content) {
      const ftype = ['static', 'regex', 'dynamic'].includes(req.body.type) ? req.body.type : 'static';
      db.prepare('INSERT INTO flags (challenge_id, content, type, case_sensitive) VALUES (?, ?, ?, ?)')
        .run(Number(req.params.id), content, ftype, req.body.case_insensitive === '1' ? 0 : 1);
    }
    res.redirect(`/admin/challenges/${Number(req.params.id)}/edit`);
  });

  router.post('/challenges/:id/flags/:fid/delete', (req, res) => {
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM flags WHERE challenge_id = ?').get(Number(req.params.id)).n;
    if (remaining <= 1) flash(req, 'error', 'A challenge must keep at least one flag.');
    else db.prepare('DELETE FROM flags WHERE id = ? AND challenge_id = ?').run(Number(req.params.fid), Number(req.params.id));
    res.redirect(`/admin/challenges/${Number(req.params.id)}/edit`);
  });

  router.post('/challenges/:id/hints', (req, res) => {
    const content = String(req.body.content || '').trim().slice(0, 2000);
    if (content) {
      db.prepare('INSERT INTO hints (challenge_id, content, cost) VALUES (?, ?, ?)').run(Number(req.params.id), content, int(req.body.cost, 0, 100000, 0));
    }
    res.redirect(`/admin/challenges/${Number(req.params.id)}/edit`);
  });

  router.post('/challenges/:id/hints/:hid/delete', (req, res) => {
    db.prepare('DELETE FROM hints WHERE id = ? AND challenge_id = ?').run(Number(req.params.hid), Number(req.params.id));
    res.redirect(`/admin/challenges/${Number(req.params.id)}/edit`);
  });

  router.post('/challenges/:id/files', upload.array('files', MAX_FILES_PER_UPLOAD), (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM challenges WHERE id = ?').get(id)) {
      storeFiles(id, req.files);
      flash(req, 'success', `${(req.files || []).length} file(s) uploaded.`);
    } else {
      discardFiles(req.files);
    }
    res.redirect(`/admin/challenges/${id}/edit`);
  });

  router.post('/challenges/:id/files/:fid/delete', (req, res) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND challenge_id = ?').get(Number(req.params.fid), Number(req.params.id));
    if (file) {
      db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
      storage.deleteFile(file.stored_name);
    }
    res.redirect(`/admin/challenges/${Number(req.params.id)}/edit`);
  });

  // Per-challenge solve stats.
  router.get('/challenges/:id/stats', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const ch = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
    if (!ch) return res.status(404).render('error', { title: 'Not found', message: 'Challenge not found.' });
    const solvers = db.prepare(`
      SELECT u.id AS user_id, u.username, s.created_at
      FROM solves s JOIN users u ON u.id = s.user_id
      WHERE s.challenge_id = ? ORDER BY s.created_at`).all(id);
    const subRows = db.prepare('SELECT correct, COUNT(*) AS n FROM submissions WHERE challenge_id = ? GROUP BY correct').all(id);
    const correct = (subRows.find((r) => r.correct === 1) || { n: 0 }).n;
    const incorrect = (subRows.find((r) => r.correct === 0) || { n: 0 }).n;
    res.render('admin/challenge_stats', { title: `Stats: ${ch.name}`, challenge: ch, solvers, correct, incorrect });
  });

  // Challenge JSON export.
  router.get('/export/challenges.json', requireAdmin, (req, res) => {
    const challenges = db.prepare('SELECT * FROM challenges ORDER BY category, id').all().map((c) => ({
      name: c.name, category: c.category, description: c.description,
      connection_info: c.connection_info, points: c.points, min_points: c.min_points,
      decay: c.decay, max_attempts: c.max_attempts, visible: c.visible,
      flags: db.prepare('SELECT content, type, case_sensitive FROM flags WHERE challenge_id = ?').all(c.id),
      hints: db.prepare('SELECT content, cost FROM hints WHERE challenge_id = ? ORDER BY id').all(c.id),
    }));
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="challenges.json"' });
    res.json(challenges);
  });

  // Live Markdown preview for the challenge editor (same renderer players get).
  router.post('/api/preview', (req, res) => {
    res.json({ html: renderMarkdown(String(req.body.text || '').slice(0, 20000)) });
  });

  // ---------- Users ----------
  router.get('/users', (req, res) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const users = db.prepare(`
      SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' ORDER BY u.created_at DESC LIMIT 200`).all(like, like);
    res.render('admin/users', { title: 'Users', users, q });
  });

  router.post('/users/:id/:action', (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).render('error', { title: 'Not found', message: 'User not found.' });
    const { action } = req.params;
    if (id === req.user.id && ['ban', 'demote', 'delete', 'hide'].includes(action)) {
      flash(req, 'error', "You can't do that to your own account.");
      return back(req, res, '/admin/users');
    }
    const set = (col, val) => db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val, id);
    switch (action) {
      case 'ban': set('banned', 1); break;
      case 'unban': set('banned', 0); break;
      case 'hide': set('hidden', 1); break;
      case 'unhide': set('hidden', 0); break;
      case 'promote': set('role', 'admin'); break;
      case 'demote': set('role', 'user'); break;
      case 'make_monitor': set('role', 'monitor'); break;
      case 'make_user': set('role', 'user'); break;
      case 'delete': db.prepare('DELETE FROM users WHERE id = ?').run(id); break;
      case 'password': {
        const pwError = validatePassword(req.body.password);
        if (pwError) { flash(req, 'error', pwError); return back(req, res, '/admin/users'); }
        set('password_hash', bcrypt.hashSync(req.body.password, config.bcryptRounds));
        break;
      }
      default: return res.status(400).render('error', { title: 'Bad request', message: 'Unknown action.' });
    }
    if (action === 'ban' || action === 'delete' || action === 'password') {
      // Invalidate their live sessions.
      db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
    }
    audit.log(db, req, `user.${action}`, target.username, `id=${id}`);
    flash(req, 'success', `User ${target.username}: ${action} done.`);
    back(req, res, '/admin/users');
  });

  // ---------- Teams ----------
  router.get('/teams', (req, res) => {
    const teams = db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS members FROM teams t ORDER BY t.created_at DESC`).all();
    res.render('admin/teams', { title: 'Teams', teams });
  });

  router.post('/teams/:id/:action', (req, res) => {
    const id = Number(req.params.id);
    const actions = {
      ban: 'UPDATE teams SET banned = 1 WHERE id = ?',
      unban: 'UPDATE teams SET banned = 0 WHERE id = ?',
      hide: 'UPDATE teams SET hidden = 1 WHERE id = ?',
      unhide: 'UPDATE teams SET hidden = 0 WHERE id = ?',
      delete: 'DELETE FROM teams WHERE id = ?',
    };
    const sql = actions[req.params.action];
    if (!sql) return res.status(400).render('error', { title: 'Bad request', message: 'Unknown action.' });
    const team = db.prepare('SELECT name FROM teams WHERE id = ?').get(id);
    db.prepare(sql).run(id);
    if (team) audit.log(db, req, `team.${req.params.action}`, team.name, `id=${id}`);
    flash(req, 'success', 'Team updated.');
    res.redirect('/admin/teams');
  });

  // ---------- Submissions ----------
  router.get('/submissions', (req, res) => {
    const page = int(req.query.page, 1, 100000, 1);
    const filter = req.query.filter === 'correct' ? 'AND s.correct = 1' : req.query.filter === 'incorrect' ? 'AND s.correct = 0' : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM submissions s WHERE 1=1 ${filter}`).get().n;
    const rows = db.prepare(`
      SELECT s.*, u.username, t.name AS team_name, c.name AS challenge FROM submissions s
      JOIN users u ON u.id = s.user_id LEFT JOIN teams t ON t.id = s.team_id JOIN challenges c ON c.id = s.challenge_id
      WHERE 1=1 ${filter} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/submissions', { title: 'Submissions', rows, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), filter: req.query.filter || '' });
  });

  // Deleting a correct submission also removes the solve it created, so scores stay consistent.
  router.post('/submissions/:id/delete', (req, res) => {
    db.transaction(() => {
      const s = db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(req.params.id));
      if (!s) return;
      if (s.correct) {
        db.prepare('DELETE FROM solves WHERE challenge_id = ? AND user_id = ? AND ((team_id IS NULL AND ? IS NULL) OR team_id = ?)').run(s.challenge_id, s.user_id, s.team_id, s.team_id);
      }
      db.prepare('DELETE FROM submissions WHERE id = ?').run(s.id);
    })();
    scoreCache.invalidate();
    audit.log(db, req, 'submission.delete', String(req.params.id));
    flash(req, 'success', 'Submission removed.');
    back(req, res, '/admin/submissions');
  });

  // ---------- Awards ----------
  router.post('/awards', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').trim());
    const value = int(req.body.value, -100000, 100000, 0);
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!user || !name || value === 0) {
      flash(req, 'error', 'Enter an existing username, a reason and a non-zero value.');
    } else {
      db.prepare('INSERT INTO awards (user_id, team_id, name, value, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, req.settings.mode === 'teams' ? user.team_id : null, name, value, Date.now());
      scoreCache.invalidate();
      audit.log(db, req, 'award.create', user.username, `value=${value} reason=${name}`);
      flash(req, 'success', `Awarded ${value} points to ${user.username}.`);
    }
    res.redirect('/admin');
  });

  // ---------- Announcements ----------
  router.get('/announcements', (req, res) => {
    res.render('admin/announcements', { title: 'Announcements', items: db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all() });
  });

  router.post('/announcements', (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 150);
    const body = String(req.body.body || '').trim().slice(0, 5000);
    if (title && body) {
      db.prepare('INSERT INTO announcements (title, body, created_at) VALUES (?, ?, ?)').run(title, body, Date.now());
      audit.log(db, req, 'announcement.create', title);
      setImmediate(() => discord.notifyAnnouncement({ title, body }).catch(() => {}));
    }
    res.redirect('/admin/announcements');
  });

  router.post('/announcements/:id/delete', (req, res) => {
    const ann = db.prepare('SELECT title FROM announcements WHERE id = ?').get(Number(req.params.id));
    db.prepare('DELETE FROM announcements WHERE id = ?').run(Number(req.params.id));
    if (ann) audit.log(db, req, 'announcement.delete', ann.title);
    res.redirect('/admin/announcements');
  });

  // ---------- Settings ----------
  router.get('/settings', (req, res) => {
    res.render('admin/settings', { title: 'Settings', errors: [] });
  });

  router.post('/settings', (req, res) => {
    const errors = [];
    const name = String(req.body.ctf_name || '').trim().slice(0, 60);
    if (!name) errors.push('CTF name is required.');
    const start = parseEpoch(req.body.start_time);
    const end = parseEpoch(req.body.end_time);
    const freeze = parseEpoch(req.body.freeze_time);
    if (start === null || end === null || freeze === null) errors.push('Invalid date/time value.');
    if (start && end && Number(end) <= Number(start)) errors.push('End time must be after start time.');
    if (freeze && end && Number(freeze) >= Number(end)) errors.push('Freeze time must be before end time.');
    const mode = req.body.mode === 'teams' ? 'teams' : 'users';
    if (mode !== req.settings.mode && db.prepare('SELECT COUNT(*) AS n FROM solves').get().n > 0) {
      errors.push('Cannot switch between user and team mode after solves exist. Delete the solves first.');
    }
    if (errors.length) return res.status(400).render('admin/settings', { title: 'Settings', errors });
    const inviteCode = String(req.body.invite_code || '').trim().slice(0, 64);
    const VALID_THEMES = ['default', 'matrix', 'blood', 'cyber', 'amber', 'ghost'];
    const theme = VALID_THEMES.includes(req.body.theme) ? req.body.theme : 'default';
    db.transaction(() => {
      setSetting(db, 'ctf_name', name);
      setSetting(db, 'mode', mode);
      setSetting(db, 'registration_open', req.body.registration_open === '1' ? '1' : '0');
      setSetting(db, 'scoreboard_public', req.body.scoreboard_public === '1' ? '1' : '0');
      setSetting(db, 'team_size', int(req.body.team_size, 1, 100, 4));
      setSetting(db, 'start_time', start);
      setSetting(db, 'end_time', end);
      setSetting(db, 'freeze_time', freeze);
      setSetting(db, 'invite_code', inviteCode);
      setSetting(db, 'theme', theme);
    })();
    audit.log(db, req, 'settings.save', '', `mode=${mode} reg=${req.body.registration_open === '1' ? 'open' : 'closed'}`);
    flash(req, 'success', 'Settings saved.');
    res.redirect('/admin/settings');
  });

  // ---------- Audit log ----------
  router.get('/audit', requireAdmin, (req, res) => {
    const page = int(req.query.page, 1, 100000, 1);
    const total = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    const rows = db.prepare(`
      SELECT a.*, u.username FROM audit_log a JOIN users u ON u.id = a.admin_id
      ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).all(PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/audit', { title: 'Audit log', rows, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });
  });

  // ---------- Writeups ----------
  router.get('/writeups', (req, res) => {
    const page = Math.max(1, int(req.query.page, 1, 100000, 1));
    const total = db.prepare('SELECT COUNT(*) AS n FROM writeups').get().n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rows = db.prepare(`
      SELECT w.id, w.url, w.created_at, u.username, u.id AS user_id,
             c.name AS challenge, c.id AS challenge_id
      FROM writeups w
      JOIN users u ON u.id = w.user_id
      JOIN challenges c ON c.id = w.challenge_id
      ORDER BY w.created_at DESC LIMIT ? OFFSET ?
    `).all(PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/writeups', { title: 'Writeups', rows, page, pages });
  });

  router.post('/writeups/:id/delete', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM writeups WHERE id = ?').run(Number(req.params.id));
    flash(req, 'Writeup deleted.', 'ok');
    back(req, res, '/admin/writeups');
  });

  function sendCsv(res, name, rows) {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }).send(toCsv(rows));
  }

  router.get('/export/scoreboard.csv', (req, res) => {
    const { standings } = computeScoreboard(db, req.settings.mode);
    sendCsv(res, 'scoreboard.csv', [['rank', 'name', 'score', 'solves'], ...standings.map((o) => [o.rank, o.name, o.score, o.solves])]);
  });

  router.get('/export/submissions.csv', (req, res) => {
    const rows = db.prepare(`
      SELECT s.id, s.created_at, u.username, c.name AS challenge, s.provided, s.correct, s.ip FROM submissions s
      JOIN users u ON u.id = s.user_id JOIN challenges c ON c.id = s.challenge_id ORDER BY s.created_at`).all();
    sendCsv(res, 'submissions.csv', [['id', 'time', 'user', 'challenge', 'provided', 'correct', 'ip'],
      ...rows.map((r) => [r.id, new Date(r.created_at).toISOString(), r.username, r.challenge, r.provided, r.correct ? 'yes' : 'no', r.ip])]);
  });

  return router;
};

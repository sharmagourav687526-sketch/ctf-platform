'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { setSetting } = require('../db');
const { requireLogin, requireAdmin, flash } = require('../middleware');
const { computeScoreboard, challengeValue, solveCounts } = require('../scoring');
const { toCsv, randomHex, parseEpoch, renderMarkdown } = require('../utils');
const { validatePassword } = require('./auth');

const PAGE_SIZE = 50;
const MAX_FILES_PER_UPLOAD = 10;

function int(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = function adminRoutes(db, config) {
  const router = express.Router();
  router.use(requireLogin, requireAdmin);

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, randomHex(16)),
    }),
    limits: { fileSize: config.maxUploadBytes, files: MAX_FILES_PER_UPLOAD },
  });

  function discardFiles(files) {
    for (const f of files || []) fs.rm(f.path, { force: true }, () => {});
  }

  // Register uploaded files against a challenge. The on-disk name is random hex; only a
  // sanitised display name is kept, so an upload can never choose where it is written.
  function storeFiles(challengeId, files) {
    const insert = db.prepare('INSERT INTO files (challenge_id, filename, stored_name, size) VALUES (?, ?, ?, ?)');
    for (const f of files || []) {
      const filename = path.basename(f.originalname).replace(/[\x00-\x1f"\\/]/g, '_').slice(0, 200) || 'file';
      insert.run(challengeId, filename, f.filename, f.size);
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
      discardFiles(req.files);
      return res.status(400).render('admin/challenge_form', {
        title: 'New challenge', challenge: values, flags: [], hints: [], files: [], others: db.prepare('SELECT id, name FROM challenges ORDER BY name').all(), errors,
      });
    }
    const id = db.transaction(() => {
      const info = db.prepare(`INSERT INTO challenges (name, category, description, connection_info, points, min_points, decay, max_attempts, visible, requires_id, created_at)
        VALUES (@name, @category, @description, @connection_info, @points, @min_points, @decay, @max_attempts, @visible, @requires_id, @created_at)`)
        .run({ ...values, created_at: Date.now() });
      db.prepare('INSERT INTO flags (challenge_id, content, type, case_sensitive) VALUES (?, ?, ?, ?)')
        .run(info.lastInsertRowid, flagContent, req.body.flag_type === 'regex' ? 'regex' : 'static', req.body.case_insensitive === '1' ? 0 : 1);
      const hint = String(req.body.hint || '').trim().slice(0, 2000);
      if (hint) db.prepare('INSERT INTO hints (challenge_id, content, cost) VALUES (?, ?, ?)').run(info.lastInsertRowid, hint, int(req.body.hint_cost, 0, 100000, 0));
      storeFiles(info.lastInsertRowid, req.files);
      return info.lastInsertRowid;
    })();
    flash(req, 'success', 'Challenge created.');
    res.redirect(`/admin/challenges/${id}/edit`);
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
      points=@points, min_points=@min_points, decay=@decay, max_attempts=@max_attempts, visible=@visible, requires_id=@requires_id WHERE id=@id`)
      .run({ ...values, id });
    flash(req, 'success', 'Challenge saved.');
    res.redirect(`/admin/challenges/${id}/edit`);
  });

  router.post('/challenges/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const files = db.prepare('SELECT stored_name FROM files WHERE challenge_id = ?').all(id);
    db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
    for (const f of files) fs.rm(path.join(config.uploadDir, f.stored_name), { force: true }, () => {});
    flash(req, 'success', 'Challenge deleted.');
    res.redirect('/admin/challenges');
  });

  router.post('/challenges/:id/flags', (req, res) => {
    const content = String(req.body.content || '').trim().slice(0, 500);
    if (content) {
      db.prepare('INSERT INTO flags (challenge_id, content, type, case_sensitive) VALUES (?, ?, ?, ?)')
        .run(Number(req.params.id), content, req.body.type === 'regex' ? 'regex' : 'static', req.body.case_insensitive === '1' ? 0 : 1);
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
      fs.rm(path.join(config.uploadDir, file.stored_name), { force: true }, () => {});
    }
    res.redirect(`/admin/challenges/${Number(req.params.id)}/edit`);
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
    db.prepare(sql).run(id);
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
    if (title && body) db.prepare('INSERT INTO announcements (title, body, created_at) VALUES (?, ?, ?)').run(title, body, Date.now());
    res.redirect('/admin/announcements');
  });

  router.post('/announcements/:id/delete', (req, res) => {
    db.prepare('DELETE FROM announcements WHERE id = ?').run(Number(req.params.id));
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
    if (start === null || end === null) errors.push('Invalid start or end time.');
    if (start && end && Number(end) <= Number(start)) errors.push('End time must be after start time.');
    const mode = req.body.mode === 'teams' ? 'teams' : 'users';
    if (mode !== req.settings.mode && db.prepare('SELECT COUNT(*) AS n FROM solves').get().n > 0) {
      errors.push('Cannot switch between user and team mode after solves exist. Delete the solves first.');
    }
    if (errors.length) return res.status(400).render('admin/settings', { title: 'Settings', errors });
    db.transaction(() => {
      setSetting(db, 'ctf_name', name);
      setSetting(db, 'mode', mode);
      setSetting(db, 'registration_open', req.body.registration_open === '1' ? '1' : '0');
      setSetting(db, 'scoreboard_public', req.body.scoreboard_public === '1' ? '1' : '0');
      setSetting(db, 'team_size', int(req.body.team_size, 1, 100, 4));
      setSetting(db, 'start_time', start);
      setSetting(db, 'end_time', end);
    })();
    flash(req, 'success', 'Settings saved.');
    res.redirect('/admin/settings');
  });

  // ---------- Exports ----------
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

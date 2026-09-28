'use strict';

/**
 * Scoring engine.
 *
 * Challenge value is computed at read time from the current solve count, so when a
 * dynamic challenge gets easier (more solves) *everyone's* score for it drops together,
 * exactly like CTFd's parabolic decay. Nothing is stored per solve.
 */

function challengeValue(ch, solveCount) {
  if (!ch.decay || ch.decay <= 0 || ch.min_points >= ch.points) return ch.points;
  // Parabolic decay: points at 0 solves, min_points at `decay` solves.
  const value = Math.ceil(((ch.min_points - ch.points) / (ch.decay * ch.decay)) * (solveCount * solveCount) + ch.points);
  return Math.max(ch.min_points, Math.min(ch.points, value));
}

/** The scoring unit for a user: their team in team mode, otherwise themselves. */
function ownerOf(mode, user) {
  return mode === 'teams' && user.team_id ? { type: 'team', id: user.team_id } : { type: 'user', id: user.id };
}

function solveCounts(db) {
  const map = new Map();
  for (const r of db.prepare('SELECT s.challenge_id AS id, COUNT(*) AS n FROM solves s JOIN users u ON u.id = s.user_id WHERE u.hidden = 0 AND u.banned = 0 GROUP BY s.challenge_id').all()) {
    map.set(r.id, r.n);
  }
  return map;
}

/**
 * Compute the ranked scoreboard plus per-owner solve timelines (for the graph).
 * @returns {{ standings: Array, timelines: Map<string, Array<[number, number]>> }}
 */
function computeScoreboard(db, mode) {
  const teamMode = mode === 'teams';
  const challenges = new Map(db.prepare('SELECT * FROM challenges').all().map((c) => [c.id, c]));
  const counts = solveCounts(db);

  const owners = new Map();
  const key = (type, id) => `${type}:${id}`;

  if (teamMode) {
    for (const t of db.prepare('SELECT id, name FROM teams WHERE hidden = 0 AND banned = 0').all()) {
      owners.set(key('team', t.id), { type: 'team', id: t.id, name: t.name, score: 0, solves: 0, last: 0, events: [] });
    }
  } else {
    for (const u of db.prepare('SELECT id, username FROM users WHERE hidden = 0 AND banned = 0').all()) {
      owners.set(key('user', u.id), { type: 'user', id: u.id, name: u.username, score: 0, solves: 0, last: 0, events: [] });
    }
  }

  const solveRows = db.prepare('SELECT challenge_id, user_id, team_id, created_at FROM solves ORDER BY created_at, id').all();
  for (const s of solveRows) {
    const ch = challenges.get(s.challenge_id);
    if (!ch) continue;
    const o = owners.get(teamMode ? key('team', s.team_id) : key('user', s.user_id));
    if (!o) continue;
    const value = challengeValue(ch, counts.get(ch.id) || 0);
    o.score += value;
    o.solves += 1;
    o.last = Math.max(o.last, s.created_at);
    o.events.push([s.created_at, value]);
  }

  for (const a of db.prepare('SELECT user_id, team_id, value, created_at FROM awards').all()) {
    const o = owners.get(teamMode ? key('team', a.team_id) : key('user', a.user_id));
    if (!o) continue;
    o.score += a.value;
    o.events.push([a.created_at, a.value]);
  }

  for (const h of db.prepare('SELECT user_id, team_id, cost, created_at FROM hint_unlocks').all()) {
    const o = owners.get(teamMode ? key('team', h.team_id) : key('user', h.user_id));
    if (!o) continue;
    o.score -= h.cost;
    o.events.push([h.created_at, -h.cost]);
  }

  // Highest score first; ties go to whoever reached it earlier.
  const standings = [...owners.values()]
    .filter((o) => o.solves > 0 || o.score !== 0)
    .sort((a, b) => b.score - a.score || a.last - b.last || a.name.localeCompare(b.name));
  standings.forEach((o, i) => { o.rank = i + 1; });

  const timelines = new Map();
  for (const o of standings) {
    let total = 0;
    o.events.sort((x, y) => x[0] - y[0]);
    timelines.set(key(o.type, o.id), o.events.map(([t, v]) => [t, (total += v)]));
  }
  return { standings, timelines };
}

module.exports = { challengeValue, ownerOf, solveCounts, computeScoreboard };

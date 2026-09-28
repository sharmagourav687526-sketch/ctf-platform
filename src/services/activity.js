'use strict';

const { challengeValue, solveCounts } = require('../scoring');

/**
 * Public-safe solve feed. Hidden/banned players and hidden challenges never appear.
 * In team mode the team name is shown instead of the individual.
 */
function recentActivity(db, mode, { limit = 20, sinceId = 0 } = {}) {
  const counts = solveCounts(db);
  const rows = db.prepare(`
    SELECT s.id, s.created_at, c.id AS challenge_id, c.name AS challenge, c.category, c.points, c.min_points, c.decay,
           u.username, t.name AS team_name,
           (SELECT MIN(x.id) FROM solves x JOIN users xu ON xu.id = x.user_id
             WHERE x.challenge_id = s.challenge_id AND xu.hidden = 0 AND xu.banned = 0) AS first_id
    FROM solves s
    JOIN users u ON u.id = s.user_id
    JOIN challenges c ON c.id = s.challenge_id
    LEFT JOIN teams t ON t.id = s.team_id
    WHERE u.hidden = 0 AND u.banned = 0 AND c.visible = 1
      AND (t.id IS NULL OR (t.hidden = 0 AND t.banned = 0))
      AND s.id > ?
    ORDER BY s.id DESC LIMIT ?`).all(sinceId, limit);

  return rows.map((r) => ({
    id: r.id,
    at: r.created_at,
    challenge: r.challenge,
    category: r.category,
    value: challengeValue(r, counts.get(r.challenge_id) || 0),
    who: mode === 'teams' && r.team_name ? r.team_name : r.username,
    firstBlood: r.id === r.first_id,
  }));
}

/** The first solvers of one challenge (oldest first), for the "solved by" list. */
function solversOf(db, mode, challengeId, limit = 10) {
  const rows = db.prepare(`
    SELECT s.id, s.created_at, u.username, t.name AS team_name
    FROM solves s JOIN users u ON u.id = s.user_id LEFT JOIN teams t ON t.id = s.team_id
    WHERE s.challenge_id = ? AND u.hidden = 0 AND u.banned = 0
      AND (t.id IS NULL OR (t.hidden = 0 AND t.banned = 0))
    ORDER BY s.id ASC LIMIT ?`).all(challengeId, limit);
  return rows.map((r, i) => ({
    who: mode === 'teams' && r.team_name ? r.team_name : r.username,
    at: r.created_at,
    firstBlood: i === 0,
  }));
}

function siteStats(db, mode) {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    players: n('SELECT COUNT(*) AS n FROM users WHERE hidden = 0 AND banned = 0'),
    teams: mode === 'teams' ? n('SELECT COUNT(*) AS n FROM teams WHERE hidden = 0 AND banned = 0') : null,
    challenges: n('SELECT COUNT(*) AS n FROM challenges WHERE visible = 1'),
    solves: n('SELECT COUNT(*) AS n FROM solves s JOIN users u ON u.id = s.user_id WHERE u.hidden = 0 AND u.banned = 0'),
  };
}

module.exports = { recentActivity, solversOf, siteStats };

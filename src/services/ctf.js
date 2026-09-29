'use strict';

const { checkFlag } = require('./flags');
const { challengeValue, ownerOf, solveCounts } = require('../scoring');
const { solversOf } = require('./activity');
const scoreCache = require('../scoreboardCache');

const ATTEMPTS_PER_MINUTE = 10;

function eventState(settings, now = Date.now()) {
  const start = settings.start_time ? Number(settings.start_time) : null;
  const end = settings.end_time ? Number(settings.end_time) : null;
  const started = start === null || now >= start;
  const ended = end !== null && now >= end;
  return { start, end, started, ended, active: started && !ended };
}

/** Solve lookup for the scoring unit that `user` plays for. */
function solvedSet(db, mode, user) {
  const owner = ownerOf(mode, user);
  const rows = owner.type === 'team'
    ? db.prepare('SELECT challenge_id FROM solves WHERE team_id = ?').all(owner.id)
    : db.prepare('SELECT challenge_id FROM solves WHERE user_id = ? AND team_id IS NULL').all(owner.id);
  return new Set(rows.map((r) => r.challenge_id));
}

function listChallenges(db, mode, user) {
  const counts = solveCounts(db);
  const solved = solvedSet(db, mode, user);
  return db.prepare('SELECT * FROM challenges WHERE visible = 1 ORDER BY category, points, id').all()
    .filter((c) => !c.requires_id || solved.has(c.requires_id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      value: challengeValue(c, counts.get(c.id) || 0),
      solves: counts.get(c.id) || 0,
      solved: solved.has(c.id),
    }));
}

function getChallenge(db, mode, user, id) {
  const c = db.prepare('SELECT * FROM challenges WHERE id = ? AND visible = 1').get(id);
  if (!c) return null;
  const solved = solvedSet(db, mode, user);
  if (c.requires_id && !solved.has(c.requires_id)) return null;
  const counts = solveCounts(db);
  const owner = ownerOf(mode, user);
  const unlocked = new Set(
    (owner.type === 'team'
      ? db.prepare('SELECT hint_id FROM hint_unlocks WHERE team_id = ?').all(owner.id)
      : db.prepare('SELECT hint_id FROM hint_unlocks WHERE user_id = ? AND team_id IS NULL').all(owner.id)
    ).map((r) => r.hint_id)
  );
  const hints = db.prepare('SELECT id, content, cost FROM hints WHERE challenge_id = ? ORDER BY id').all(id)
    .map((h) => (unlocked.has(h.id) ? { id: h.id, cost: h.cost, unlocked: true, content: h.content } : { id: h.id, cost: h.cost, unlocked: false }));
  const attempts = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE challenge_id = ? AND user_id = ?').get(id, user.id).n;
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    description: c.description,
    connection_info: c.connection_info,
    value: challengeValue(c, counts.get(c.id) || 0),
    solves: counts.get(c.id) || 0,
    solved: solved.has(c.id),
    max_attempts: c.max_attempts,
    attempts,
    hints,
    files: db.prepare('SELECT id, filename, size FROM files WHERE challenge_id = ?').all(id),
    solvers: solversOf(db, mode, id),
  };
}

/**
 * Handle a flag submission. Everything that decides the outcome runs in one
 * transaction so concurrent submissions can't double-award a solve.
 */
function submitFlag(db, { settings, user, challengeId, provided, ip, now = Date.now() }) {
  const mode = settings.mode;
  const state = eventState(settings, now);
  if (!state.started) return { status: 'closed', message: 'The CTF has not started yet.' };
  if (state.ended) return { status: 'closed', message: 'The CTF has ended. Submissions are closed.' };
  if (mode === 'teams' && !user.team_id) return { status: 'no_team', message: 'Join or create a team before submitting flags.' };

  return db.transaction(() => {
    const ch = db.prepare('SELECT * FROM challenges WHERE id = ? AND visible = 1').get(challengeId);
    if (!ch) return { status: 'not_found', message: 'Challenge not found.' };

    const solved = solvedSet(db, mode, user);
    if (ch.requires_id && !solved.has(ch.requires_id)) return { status: 'not_found', message: 'Challenge not found.' };
    if (solved.has(ch.id)) return { status: 'already_solved', message: 'Your team has already solved this challenge.' };

    const recent = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND created_at > ?').get(user.id, now - 60000).n;
    if (recent >= ATTEMPTS_PER_MINUTE) return { status: 'ratelimited', message: 'Too many attempts. Wait a minute and try again.' };

    if (ch.max_attempts > 0) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE challenge_id = ? AND user_id = ?').get(ch.id, user.id).n;
      if (used >= ch.max_attempts) return { status: 'max_attempts', message: 'You have used all attempts for this challenge.' };
    }

    const flags = db.prepare('SELECT * FROM flags WHERE challenge_id = ?').all(ch.id);
    const correct = checkFlag(flags, provided);
    const teamId = mode === 'teams' ? user.team_id : null;
    db.prepare('INSERT INTO submissions (challenge_id, user_id, team_id, provided, correct, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ch.id, user.id, teamId, String(provided).slice(0, 500), correct ? 1 : 0, ip || null, now);

    if (!correct) return { status: 'incorrect', message: 'Incorrect flag.' };

    const firstBlood = db.prepare('SELECT COUNT(*) AS n FROM solves WHERE challenge_id = ?').get(ch.id).n === 0;
    db.prepare('INSERT INTO solves (challenge_id, user_id, team_id, created_at) VALUES (?, ?, ?, ?)').run(ch.id, user.id, teamId, now);
    scoreCache.invalidate();
    const value = challengeValue(ch, solveCounts(db).get(ch.id) || 0);
    return { status: 'correct', message: firstBlood ? `Correct! First blood! +${value} points` : `Correct! +${value} points`, firstBlood, value };
  })();
}

function unlockHint(db, { settings, user, hintId, now = Date.now() }) {
  const state = eventState(settings, now);
  if (!state.active) return { status: 'closed', message: 'The CTF is not running.' };
  if (settings.mode === 'teams' && !user.team_id) return { status: 'no_team', message: 'Join a team first.' };
  return db.transaction(() => {
    const hint = db.prepare('SELECT h.* FROM hints h JOIN challenges c ON c.id = h.challenge_id WHERE h.id = ? AND c.visible = 1').get(hintId);
    if (!hint) return { status: 'not_found', message: 'Hint not found.' };
    const owner = ownerOf(settings.mode, user);
    const existing = owner.type === 'team'
      ? db.prepare('SELECT 1 FROM hint_unlocks WHERE hint_id = ? AND team_id = ?').get(hintId, owner.id)
      : db.prepare('SELECT 1 FROM hint_unlocks WHERE hint_id = ? AND user_id = ? AND team_id IS NULL').get(hintId, owner.id);
    if (!existing) {
      db.prepare('INSERT INTO hint_unlocks (hint_id, user_id, team_id, cost, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(hintId, user.id, owner.type === 'team' ? owner.id : null, hint.cost, now);
    }
    return { status: 'ok', content: hint.content, cost: hint.cost };
  })();
}

module.exports = { eventState, listChallenges, getChallenge, submitFlag, unlockHint, ATTEMPTS_PER_MINUTE };

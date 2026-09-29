'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const USERS_TABLE = `CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','monitor')),
  team_id        INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  country        TEXT,
  hidden         INTEGER NOT NULL DEFAULT 0,
  banned         INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
)`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','monitor')),
  team_id        INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  country        TEXT,
  hidden         INTEGER NOT NULL DEFAULT 0,
  banned         INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  invite_code TEXT NOT NULL UNIQUE,
  captain_id  INTEGER,
  hidden      INTEGER NOT NULL DEFAULT 0,
  banned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  connection_info TEXT NOT NULL DEFAULT '',
  points          INTEGER NOT NULL DEFAULT 100,
  min_points      INTEGER NOT NULL DEFAULT 100,
  decay           INTEGER NOT NULL DEFAULT 0,       -- solves needed to reach min_points; 0 = static scoring
  max_attempts    INTEGER NOT NULL DEFAULT 0,       -- 0 = unlimited
  visible         INTEGER NOT NULL DEFAULT 1,
  requires_id     INTEGER REFERENCES challenges(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flags (
  id             INTEGER PRIMARY KEY,
  challenge_id   INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  content        TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'static' CHECK (type IN ('static','regex')),
  case_sensitive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hints (
  id           INTEGER PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  cost         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hint_unlocks (
  id         INTEGER PRIMARY KEY,
  hint_id    INTEGER NOT NULL REFERENCES hints(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id    INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  cost       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  stored_name  TEXT NOT NULL UNIQUE,
  size         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id      INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  provided     TEXT NOT NULL,
  correct      INTEGER NOT NULL,
  ip           TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_challenge ON submissions(challenge_id);
CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id, challenge_id);

CREATE TABLE IF NOT EXISTS solves (
  id           INTEGER PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id      INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL
);
-- One solve per challenge per scoring unit (team, or user when not on a team).
CREATE UNIQUE INDEX IF NOT EXISTS uq_solve_team ON solves(challenge_id, team_id) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_solve_user ON solves(challenge_id, user_id) WHERE team_id IS NULL;

CREATE TABLE IF NOT EXISTS awards (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team_id    INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL CHECK (type IN ('verify','reset')),
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  ctf_name: 'My CTF',
  mode: 'users',              // 'users' | 'teams'
  registration_open: '1',
  scoreboard_public: '1',
  team_size: '4',
  start_time: '',             // epoch ms; empty = already started
  end_time: '',               // epoch ms; empty = never ends
};

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Migration: widen role CHECK constraint to include 'monitor'.
  // legacy_alter_table=ON prevents SQLite from rewriting FK references in other
  // tables when we rename users → _users_old, so those tables keep pointing at
  // the new "users" table after we recreate it.
  const usersRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (usersRow && !usersRow.sql.includes("'monitor'")) {
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    db.exec('ALTER TABLE users RENAME TO _users_old');
    db.exec(USERS_TABLE.replace('CREATE TABLE users', 'CREATE TABLE IF NOT EXISTS users'));
    db.exec('INSERT INTO users SELECT * FROM _users_old');
    db.exec('DROP TABLE _users_old');
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }
  // Migration: add email_verified column. Existing users default to 1 (already trusted).
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
  }

  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seed.run(k, v);
  return db;
}

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

module.exports = { openDb, getSettings, setSetting, DEFAULT_SETTINGS };

'use strict';

// Loads example challenges so a fresh install has something to play with.
// Safe to run once; it refuses to touch a database that already has challenges.

const config = require('../src/config');
const { openDb } = require('../src/db');

const db = openDb(config.dbFile);

if (db.prepare('SELECT COUNT(*) AS n FROM challenges').get().n > 0) {
  console.error('Database already has challenges; not seeding.');
  process.exit(1);
}

const samples = [
  {
    name: 'Welcome', category: 'misc', points: 10,
    description: 'Every CTF starts the same way. The flag format is `CTF{...}`.\n\nHere it is, for free: `CTF{welcome_to_the_ctf}`',
    flags: ['CTF{welcome_to_the_ctf}'],
  },
  {
    name: 'Base64 Basics', category: 'crypto', points: 50,
    description: 'Decode this message:\n\n```\nQ1RGe2Jhc2U2NF9pc19ub3RfZW5jcnlwdGlvbn0=\n```',
    flags: ['CTF{base64_is_not_encryption}'],
    hints: [{ content: 'It is an encoding, not encryption. Look for the `=` padding.', cost: 5 }],
  },
  {
    name: 'Caesar Salad', category: 'crypto', points: 100, decay: 20, min_points: 30,
    description: 'Julius sent this to a friend:\n\n```\nFWI{fdhvdu_lv_wrr_hdv|}\n```\n\nThe shift is small.',
    flags: ['CTF{caesar_is_too_easy}'],
    hints: [{ content: 'Try shifting every letter back by 3.', cost: 10 }],
  },
  {
    name: 'View Source', category: 'web', points: 75,
    description: 'The flag is hiding in plain sight on a page you visit every day. Try **view-source**.\n\n(Example challenge: replace with your own hosted target.)',
    flags: ['CTF{view_source_is_a_superpower}'],
    connection_info: 'http://localhost:8080',
  },
  {
    name: 'Regex Flag', category: 'misc', points: 150, decay: 10, min_points: 50,
    description: 'This challenge accepts **any** flag of the form `CTF{regex_<digits>}`. Made to demo regex flags.',
    flags: [{ content: 'CTF\\{regex_\\d+\\}', type: 'regex' }],
  },
];

db.transaction(() => {
  const now = Date.now();
  const insertChallenge = db.prepare(`INSERT INTO challenges (name, category, description, connection_info, points, min_points, decay, max_attempts, visible, created_at)
    VALUES (@name, @category, @description, @connection_info, @points, @min_points, @decay, 0, 1, @now)`);
  const insertFlag = db.prepare('INSERT INTO flags (challenge_id, content, type, case_sensitive) VALUES (?, ?, ?, 1)');
  const insertHint = db.prepare('INSERT INTO hints (challenge_id, content, cost) VALUES (?, ?, ?)');

  for (const s of samples) {
    const info = insertChallenge.run({
      name: s.name, category: s.category, description: s.description, connection_info: s.connection_info || '',
      points: s.points, min_points: s.min_points || s.points, decay: s.decay || 0, now,
    });
    for (const f of s.flags) {
      if (typeof f === 'string') insertFlag.run(info.lastInsertRowid, f, 'static');
      else insertFlag.run(info.lastInsertRowid, f.content, f.type);
    }
    for (const h of s.hints || []) insertHint.run(info.lastInsertRowid, h.content, h.cost);
  }
})();

console.log(`Seeded ${samples.length} example challenges.`);
db.close();

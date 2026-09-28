'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { challengeValue, computeScoreboard } = require('../src/scoring');
const { checkFlag } = require('../src/services/flags');
const { renderMarkdown, csvCell, parseEpoch } = require('../src/utils');
const { openDb } = require('../src/db');

test('static challenges always keep their points', () => {
  const ch = { points: 300, min_points: 300, decay: 0 };
  assert.equal(challengeValue(ch, 0), 300);
  assert.equal(challengeValue(ch, 50), 300);
});

test('dynamic value decays to the minimum and never below it', () => {
  const ch = { points: 500, min_points: 100, decay: 10 };
  assert.equal(challengeValue(ch, 0), 500);
  assert.equal(challengeValue(ch, 5), 400);
  assert.equal(challengeValue(ch, 10), 100);
  assert.equal(challengeValue(ch, 999), 100);
});

test('static flags: exact, case handling and wrong answers', () => {
  const flags = [{ type: 'static', content: 'CTF{Secret}', case_sensitive: 1 }];
  assert.equal(checkFlag(flags, 'CTF{Secret}'), true);
  assert.equal(checkFlag(flags, '  CTF{Secret}\n'), true, 'surrounding whitespace is ignored');
  assert.equal(checkFlag(flags, 'ctf{secret}'), false);
  assert.equal(checkFlag([{ ...flags[0], case_sensitive: 0 }], 'ctf{secret}'), true);
  assert.equal(checkFlag(flags, 'CTF{Secret}x'), false);
});

test('regex flags must match the whole input and bad patterns never match', () => {
  const flags = [{ type: 'regex', content: 'CTF\\{n\\d+\\}', case_sensitive: 1 }];
  assert.equal(checkFlag(flags, 'CTF{n42}'), true);
  assert.equal(checkFlag(flags, 'xCTF{n42}'), false);
  assert.equal(checkFlag([{ type: 'regex', content: '(', case_sensitive: 1 }], '('), false);
});

test('flag input is bounded and type-checked', () => {
  const flags = [{ type: 'static', content: 'a', case_sensitive: 1 }];
  assert.equal(checkFlag(flags, ''), false);
  assert.equal(checkFlag(flags, 'a'.repeat(501)), false);
  assert.equal(checkFlag(flags, { toString: () => 'a' }), false);
  assert.equal(checkFlag(flags, undefined), false);
});

test('markdown escapes HTML before formatting', () => {
  const html = renderMarkdown('<script>alert(1)</script> **bold** `code` [x](javascript:alert(1)) [ok](https://example.com)');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(!html.includes('href="javascript'), 'javascript: links are not linkified');
  assert.ok(html.includes('href="https://example.com"'));
});

test('markdown keeps fenced code verbatim (escaped)', () => {
  const html = renderMarkdown('```\n<b>*not bold*</b>\n```');
  assert.ok(html.includes('<pre><code>&lt;b&gt;*not bold*&lt;/b&gt;</code></pre>'));
});

test('CSV cells are quoted and defused against formula injection', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell(null), '');
});

test('parseEpoch accepts blanks and positive numbers only', () => {
  assert.equal(parseEpoch(''), '');
  assert.equal(parseEpoch('1700000000000'), '1700000000000');
  assert.equal(parseEpoch('abc'), null);
  assert.equal(parseEpoch('-5'), null);
});

test('scoreboard ranks by score, then by who got there first, and ignores hidden users', () => {
  const db = openDb(':memory:');
  const user = db.prepare('INSERT INTO users (username, email, password_hash, hidden, created_at) VALUES (?, ?, ?, ?, 0)');
  const a = user.run('alice', 'a@x.io', 'x', 0).lastInsertRowid;
  const b = user.run('bob', 'b@x.io', 'x', 0).lastInsertRowid;
  const ghost = user.run('ghost', 'g@x.io', 'x', 1).lastInsertRowid;
  const chal = db.prepare('INSERT INTO challenges (name, category, points, min_points, created_at) VALUES (?, ?, ?, ?, 0)');
  const c1 = chal.run('one', 'web', 100, 100).lastInsertRowid;
  const c2 = chal.run('two', 'web', 50, 50).lastInsertRowid;
  const solve = db.prepare('INSERT INTO solves (challenge_id, user_id, created_at) VALUES (?, ?, ?)');
  solve.run(c1, b, 1000);   // bob: 100 at t=1000
  solve.run(c1, a, 2000);   // alice: 100 at t=2000
  solve.run(c2, ghost, 500);
  solve.run(c2, a, 3000);   // alice: +50 -> 150
  const { standings } = computeScoreboard(db, 'users');
  assert.deepEqual(standings.map((s) => [s.name, s.score, s.rank]), [['alice', 150, 1], ['bob', 100, 2]]);
});

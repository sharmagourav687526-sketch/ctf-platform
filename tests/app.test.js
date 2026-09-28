'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');

async function createChallenge(admin, fields = {}) {
  const res = await admin.post('/admin/challenges', {
    name: 'Test challenge', category: 'web', points: '100', min_points: '100', decay: '0', max_attempts: '0',
    visible: '1', flag: 'CTF{ok}', flag_type: 'static', description: 'desc', ...fields,
  });
  assert.equal(res.status, 302, 'challenge creation redirects to the edit page');
  return Number(/\/admin\/challenges\/(\d+)\/edit/.exec(res.headers.get('location'))[1]);
}

test('security basics: CSRF, auth gates and headers', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const anon = new Client(s.base);
  const home = await anon.get('/');
  assert.equal(home.status, 200);
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.equal(home.headers.get('x-powered-by'), null);

  const noToken = await anon.req('POST', '/register', { form: { username: 'x', email: 'x@x.io', password: 'longenough1', confirm: 'longenough1' } });
  assert.equal(noToken.status, 403, 'POST without a CSRF token is rejected');

  assert.equal((await anon.get('/api/challenges')).status, 401);
  assert.equal((await anon.get('/challenges')).status, 302);
  assert.equal((await anon.get('/admin')).status, 302);
  assert.equal((await anon.get('/healthz')).status, 200);
});

test('first user becomes admin, later users do not, and /admin is hidden from players', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  assert.equal((await admin.register('boss')).status, 302);
  assert.equal(s.db.prepare("SELECT role FROM users WHERE username = 'boss'").get().role, 'admin');
  assert.equal((await admin.get('/admin')).status, 200);

  const player = new Client(s.base);
  await player.register('player1');
  assert.equal(s.db.prepare("SELECT role FROM users WHERE username = 'player1'").get().role, 'user');
  assert.equal((await player.get('/admin')).status, 404);
  assert.equal((await player.post('/admin/challenges', { name: 'x' })).status, 404);
});

test('registration validation and login', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const c = new Client(s.base);
  await c.register('alice');
  const dup = await new Client(s.base).register('ALICE');
  assert.equal(dup.status, 400, 'usernames are unique case-insensitively');
  const weak = await new Client(s.base).register('bob', 'short');
  assert.equal(weak.status, 400);
  const badName = await new Client(s.base).register('a b<script>');
  assert.equal(badName.status, 400);

  const login = new Client(s.base);
  assert.equal((await login.post('/login', { name: 'alice', password: 'wrong-password' })).status, 401);
  const ok = await login.post('/login', { name: 'alice', password: 'correct-horse-9' });
  assert.equal(ok.status, 302);
  assert.equal((await login.get('/challenges')).status, 200);

  // Open-redirect protection on returnTo.
  const evil = new Client(s.base);
  await evil.get('/challenges'); // sets returnTo = /challenges
  const res = await evil.post('/login', { name: 'alice', password: 'correct-horse-9' });
  assert.match(res.headers.get('location'), /^\/(?!\/)/);
});

test('flag flow: wrong, right, duplicate, points and scoreboard', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const id = await createChallenge(admin, { points: '200', name: 'Flag me' });

  const p = new Client(s.base);
  await p.register('alice');

  const list = await (await p.get('/api/challenges')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].value, 200);
  assert.ok(!('flags' in list[0]) && !JSON.stringify(list).includes('CTF{ok}'), 'flags never leak in the list');

  const detail = await (await p.get(`/api/challenges/${id}`)).json();
  assert.ok(!JSON.stringify(detail).includes('CTF{ok}'), 'flags never leak in the detail');

  const wrong = await (await p.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{nope}' })).json();
  assert.equal(wrong.status, 'incorrect');

  const right = await (await p.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' })).json();
  assert.equal(right.status, 'correct');
  assert.equal(right.firstBlood, true);

  const again = await (await p.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' })).json();
  assert.equal(again.status, 'already_solved');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM solves').get().n, 1, 'no duplicate solve');

  const board = await (await new Client(s.base).get('/api/scoreboard')).json();
  assert.deepEqual(board.standings.map((r) => [r.name, r.score, r.rank]), [['alice', 200, 1]]);

  const second = new Client(s.base);
  await second.register('bob');
  const bobRight = await (await second.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' })).json();
  assert.equal(bobRight.firstBlood, false);
});

test('dynamic scoring lowers everyone\'s points as solves accumulate', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const id = await createChallenge(admin, { points: '500', min_points: '100', decay: '4' });

  const clients = [];
  for (const name of ['player1', 'player2']) {
    const c = new Client(s.base);
    assert.equal((await c.register(name)).status, 302);
    clients.push(c);
  }
  await clients[0].api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' });
  const after1 = await (await clients[0].get(`/api/challenges/${id}`)).json();
  await clients[1].api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' });
  const after2 = await (await clients[0].get(`/api/challenges/${id}`)).json();
  assert.ok(after2.value < after1.value, `value dropped from ${after1.value} to ${after2.value}`);

  const board = await (await clients[0].get('/api/scoreboard')).json();
  assert.equal(board.standings[0].score, board.standings[1].score, 'both solvers get the same (decayed) value');
});

test('attempt limits, rate limiting and hidden challenges', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const limited = await createChallenge(admin, { name: 'limited', max_attempts: '2' });
  const hidden = await createChallenge(admin, { name: 'secret', visible: '' });
  const busy = await createChallenge(admin, { name: 'busy' });

  const p = new Client(s.base);
  await p.register('alice');

  await p.api(`/api/challenges/${limited}/attempt`, { flag: 'a' });
  await p.api(`/api/challenges/${limited}/attempt`, { flag: 'b' });
  const third = await (await p.api(`/api/challenges/${limited}/attempt`, { flag: 'CTF{ok}' })).json();
  assert.equal(third.status, 'max_attempts');

  const hiddenTry = await p.api(`/api/challenges/${hidden}/attempt`, { flag: 'CTF{ok}' });
  assert.equal(hiddenTry.status, 404);
  assert.equal((await p.get(`/api/challenges/${hidden}`)).status, 404);

  let limitedAt = null;
  for (let i = 0; i < 12; i++) {
    const r = await p.api(`/api/challenges/${busy}/attempt`, { flag: `guess${i}` });
    if (r.status === 429) { limitedAt = i; break; }
  }
  assert.ok(limitedAt !== null && limitedAt <= 9, 'rapid guessing gets rate limited');
});

test('prerequisites hide dependent challenges until the parent is solved', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const parent = await createChallenge(admin, { name: 'parent' });
  const child = await createChallenge(admin, { name: 'child', requires_id: String(parent), flag: 'CTF{child}' });

  const p = new Client(s.base);
  await p.register('alice');
  assert.deepEqual((await (await p.get('/api/challenges')).json()).map((c) => c.name), ['parent']);
  assert.equal((await p.api(`/api/challenges/${child}/attempt`, { flag: 'CTF{child}' })).status, 404);

  await p.api(`/api/challenges/${parent}/attempt`, { flag: 'CTF{ok}' });
  assert.equal((await (await p.get('/api/challenges')).json()).length, 2);
  assert.equal((await (await p.api(`/api/challenges/${child}/attempt`, { flag: 'CTF{child}' })).json()).status, 'correct');
});

test('hints cost points and unlock content only after purchase', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const id = await createChallenge(admin, { points: '100' });
  await admin.post(`/admin/challenges/${id}/hints`, { content: 'the secret hint', cost: '30' });

  const p = new Client(s.base);
  await p.register('alice');
  const before = await (await p.get(`/api/challenges/${id}`)).json();
  assert.equal(before.hints[0].unlocked, false);
  assert.ok(!JSON.stringify(before).includes('the secret hint'));

  const unlock = await (await p.api(`/api/hints/${before.hints[0].id}/unlock`)).json();
  assert.equal(unlock.content, 'the secret hint');
  await p.api(`/api/hints/${before.hints[0].id}/unlock`); // idempotent: no double charge
  await p.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' });

  const board = await (await p.get('/api/scoreboard')).json();
  assert.equal(board.standings[0].score, 70);
});

test('event window: not started and ended block submissions', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const id = await createChallenge(admin);
  const p = new Client(s.base);
  await p.register('alice');

  const set = (k, v) => s.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(v), k);

  set('start_time', Date.now() + 3600_000);
  assert.equal((await p.get('/api/challenges')).status, 403);
  assert.equal((await admin.get('/api/challenges')).status, 200, 'admins can preview before the start');

  set('start_time', '');
  set('end_time', Date.now() - 1000);
  const closed = await (await p.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' })).json();
  assert.equal(closed.status, 'closed');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM solves').get().n, 0);
});

test('team mode: solves are shared, and users without a team cannot submit', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  await admin.post('/admin/settings', { ctf_name: 'T', mode: 'teams', team_size: '2', registration_open: '1', scoreboard_public: '1', start_time: '', end_time: '' });
  const id = await createChallenge(admin, { points: '100' });

  const a = new Client(s.base);
  await a.register('alice');
  const lone = await (await a.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' })).json();
  assert.equal(lone.status, 'no_team');

  await a.post('/team/create', { name: 'The Team' });
  const code = s.db.prepare('SELECT invite_code FROM teams').get().invite_code;

  const b = new Client(s.base);
  await b.register('bob');
  assert.equal((await b.post('/team/join', { code: 'wrong' })).status, 400);
  assert.equal((await b.post('/team/join', { code })).status, 302);

  const c = new Client(s.base);
  await c.register('carol');
  assert.equal((await c.post('/team/join', { code })).status, 400, 'team size limit is enforced');

  assert.equal((await (await a.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' })).json()).status, 'correct');
  assert.equal((await (await b.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' })).json()).status, 'already_solved', "teammate's solve counts for the team");

  const board = await (await a.get('/api/scoreboard')).json();
  assert.deepEqual(board.standings.map((r) => [r.name, r.score]), [['The Team', 100]]);
});

test('admin: bans block login, deleting a correct submission removes the solve', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const id = await createChallenge(admin);
  const p = new Client(s.base);
  await p.register('alice');
  await p.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' });

  const sub = s.db.prepare('SELECT id FROM submissions WHERE correct = 1').get();
  await admin.post(`/admin/submissions/${sub.id}/delete`, {});
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM solves').get().n, 0);
  assert.equal((await (await p.get('/api/scoreboard')).json()).standings.length, 0);

  const alice = s.db.prepare("SELECT id FROM users WHERE username = 'alice'").get();
  await admin.post(`/admin/users/${alice.id}/ban`, {});
  assert.equal((await p.get('/api/challenges')).status, 401, 'live session is invalidated by the ban');
  const relogin = await new Client(s.base).post('/login', { name: 'alice', password: 'correct-horse-9' });
  assert.equal(relogin.status, 403);
});

test('challenge descriptions are sanitised before they reach players', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const id = await createChallenge(admin, { description: '<img src=x onerror=alert(1)> **hi**' });
  const p = new Client(s.base);
  await p.register('alice');
  const detail = await (await p.get(`/api/challenges/${id}`)).json();
  assert.ok(!detail.description_html.includes('<img'));
  assert.ok(detail.description_html.includes('<strong>hi</strong>'));
});

test('admin settings validate input and exports are safe CSV', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const bad = await admin.post('/admin/settings', { ctf_name: '', mode: 'users' });
  assert.equal(bad.status, 400);
  const badTime = await admin.post('/admin/settings', { ctf_name: 'X', mode: 'users', start_time: '2000', end_time: '1000' });
  assert.equal(badTime.status, 400);

  const csv = await admin.get('/admin/export/scoreboard.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
});

test('every page renders without template errors (admin and player, user and team mode)', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const id = await createChallenge(admin, { name: 'Renderable', description: 'x' });
  await admin.post(`/admin/challenges/${id}/hints`, { content: 'hint', cost: '5' });
  await admin.post('/admin/announcements', { title: 'Hello', body: 'Welcome **all**' });
  const p = new Client(s.base);
  await p.register('alice');
  await p.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' });
  await p.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{wrong}' });
  const aliceId = s.db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;

  const adminPages = ['/', '/challenges', '/scoreboard', '/settings', '/admin', '/admin/challenges', '/admin/challenges/new',
    `/admin/challenges/${id}/edit`, '/admin/users', '/admin/users?q=ali', '/admin/submissions', '/admin/submissions?filter=correct',
    '/admin/announcements', '/admin/settings', `/users/${aliceId}`, '/admin/export/submissions.csv', '/login', '/register'];
  for (const url of adminPages) {
    const res = await admin.get(url);
    assert.ok([200, 302].includes(res.status), `${url} -> ${res.status}`);
    if (res.status === 200) assert.ok((await res.text()).length > 50, `${url} has a body`);
  }
  assert.equal((await new Client(s.base).get('/nope')).status, 404);

  await admin.post('/admin/settings', { ctf_name: 'T', mode: 'teams', team_size: '3', registration_open: '1', scoreboard_public: '1', start_time: '', end_time: '' });
  // Mode can't switch once solves exist, so verify the guard and then render teams pages on a fresh server.
  assert.equal(s.db.prepare("SELECT value FROM settings WHERE key = 'mode'").get().value, 'users');

  const s2 = await startServer();
  t.after(s2.close);
  const a2 = new Client(s2.base);
  await a2.register('boss');
  await a2.post('/admin/settings', { ctf_name: 'T', mode: 'teams', team_size: '3', registration_open: '1', scoreboard_public: '1', start_time: '', end_time: '' });
  await a2.post('/team/create', { name: 'Team Rocket' });
  const teamId = s2.db.prepare('SELECT id FROM teams').get().id;
  for (const url of ['/team', '/admin/teams', `/teams/${teamId}`, '/scoreboard', '/challenges']) {
    const res = await a2.get(url);
    assert.equal(res.status, 200, `${url} -> ${res.status}`);
  }
});

test('admins can attach files when creating a challenge, and players can download them', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const res = await admin.multipart('/admin/challenges', {
    name: 'With files', category: 'forensics', points: '100', min_points: '100', decay: '0', max_attempts: '0',
    visible: '1', flag: 'CTF{ok}', flag_type: 'static', description: 'see attachment', hint: 'look closer', hint_cost: '10',
  }, [{ name: 'evidence.txt', content: 'secret evidence contents' }, { name: '../../evil.txt', content: 'x' }]);
  assert.equal(res.status, 302);
  const id = Number(/\/admin\/challenges\/(\d+)\/edit/.exec(res.headers.get('location'))[1]);

  const p = new Client(s.base);
  await p.register('alice');
  const detail = await (await p.get(`/api/challenges/${id}`)).json();
  assert.equal(detail.files.length, 2);
  assert.equal(detail.hints.length, 1, 'the optional first hint was created too');
  assert.ok(detail.files.every((f) => !f.filename.includes('/') && !f.filename.includes('..\\')), 'stored display names are path-free');

  const dl = await p.get(`/files/${detail.files.find((f) => f.filename === 'evidence.txt').id}`);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'secret evidence contents');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await new Client(s.base).get(`/files/${detail.files[0].id}`)).status, 302, 'downloads require login');

  // Extra files can be added later from the edit page.
  const more = await admin.multipart(`/admin/challenges/${id}/files`, {}, [{ name: 'more.bin', content: '1234' }]);
  assert.equal(more.status, 302);
  assert.equal((await (await p.get(`/api/challenges/${id}`)).json()).files.length, 3);

  // Players cannot upload; missing CSRF is rejected.
  assert.equal((await p.multipart('/admin/challenges', { name: 'x' }, [{ name: 'a', content: 'b' }])).status, 404);
  const noToken = await fetch(`${s.base}/admin/challenges`, { method: 'POST', body: new FormData(), headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(noToken.status, 403);

  // A failed validation must not leave orphaned files on disk.
  const before = s.db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
  const bad = await admin.multipart('/admin/challenges', { name: '', category: '', flag: '' }, [{ name: 'orphan.txt', content: 'zzz' }]);
  assert.equal(bad.status, 400);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, before);
});

test('activity feed, solvers list and first blood', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  const id = await createChallenge(admin, { name: 'Feedable', points: '80' });
  const a = new Client(s.base); await a.register('alice');
  const b = new Client(s.base); await b.register('bobby');
  await a.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' });
  await b.api(`/api/challenges/${id}/attempt`, { flag: 'CTF{ok}' });

  const feed = await (await new Client(s.base).get('/api/activity')).json();
  assert.deepEqual(feed.map((f) => [f.who, f.firstBlood]), [['bobby', false], ['alice', true]], 'newest first, oldest solver has first blood');
  assert.equal(feed[0].value, 80);

  const since = await (await a.get(`/api/activity?since=${feed[1].id}`)).json();
  assert.deepEqual(since.map((f) => f.who), ['bobby'], "`since` returns only newer solves");

  const detail = await (await a.get(`/api/challenges/${id}`)).json();
  assert.deepEqual(detail.solvers.map((x) => [x.who, x.firstBlood]), [['alice', true], ['bobby', false]]);

  // Hidden players never appear publicly.
  const bobId = s.db.prepare("SELECT id FROM users WHERE username = 'bobby'").get().id;
  await admin.post(`/admin/users/${bobId}/hide`, {});
  assert.deepEqual((await (await a.get('/api/activity')).json()).map((f) => f.who), ['alice']);
  assert.deepEqual((await (await a.get(`/api/challenges/${id}`)).json()).solvers.map((x) => x.who), ['alice']);

  // A private scoreboard hides the feed from logged-out visitors.
  s.db.prepare("UPDATE settings SET value = '0' WHERE key = 'scoreboard_public'").run();
  assert.equal((await new Client(s.base).get('/api/activity')).status, 302);
  assert.equal((await a.get('/api/activity')).status, 200);
});

test('announcements are public, and the Markdown preview endpoint is admin-only and sanitised', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = new Client(s.base);
  await admin.register('boss');
  await admin.post('/admin/announcements', { title: 'Server maintenance', body: 'Back at **noon** <script>x</script>' });

  const anon = new Client(s.base);
  const list = await (await anon.get('/api/announcements')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Server maintenance');
  const page = await (await anon.get('/announcements')).text();
  assert.match(page, /Server maintenance/);
  assert.ok(!page.includes('<script>x</script>'), 'announcement HTML is escaped');
  assert.match(page, /<strong>noon<\/strong>/);

  const preview = await (await admin.api('/admin/api/preview', { text: '**hi** <img src=x onerror=1>' })).json();
  assert.ok(preview.html.includes('<strong>hi</strong>') && !preview.html.includes('<img'));

  const player = new Client(s.base);
  await player.register('alice');
  assert.equal((await player.api('/admin/api/preview', { text: 'x' })).status, 403);
});

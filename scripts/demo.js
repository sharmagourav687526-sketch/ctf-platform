'use strict';

// Populates the database with demo data for a realistic dashboard preview:
//   - 4 rich announcements (event info, prizes, sponsors, schedule)
//   - 8 dummy player accounts (password: "hackfest2026")
//   - solves spread across realistic timestamps
//
// Safe to run multiple times — skips items that already exist.
// Requires challenges to already be seeded (run `npm run seed` first).

const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { openDb } = require('../src/db');

const db = openDb(config.dbFile);

// ── Announcements ─────────────────────────────────────────────────────────────

const announcements = [
  {
    title: 'Welcome to HackFest 2026!',
    body: `## About the Event

HackFest 2026 is a **48-hour jeopardy-style CTF** open to individuals and teams worldwide.

| | |
|---|---|
| **Start** | October 10, 2026 — 10:00 UTC |
| **End** | October 12, 2026 — 10:00 UTC |
| **Format** | Jeopardy (Web, Crypto, Pwn, Forensics, Misc) |
| **Team size** | Up to 4 members |

## Rules

- No attacking other teams or platform infrastructure.
- No flag sharing outside your team.
- Automated solvers / bots are not permitted.
- Each challenge has a hint system — use points wisely.
- Admin decisions are final.

## Community

Join our **Discord** server for real-time hints, announcements and banter with other participants.
Link in your profile after registration.`,
    created_at: Date.now() - 7 * 24 * 3600 * 1000,
  },
  {
    title: 'Prize Pool: $1,500 + Trophies',
    body: `## Overall Standings

| Place | Prize |
|---|---|
| 🥇 1st | **$500 cash** + HackFest 2026 Trophy + Premium swag bag |
| 🥈 2nd | **$250 cash** + Medal + Swag bag |
| 🥉 3rd | **$100 cash** + Medal |

## Category Prizes (top solver per category)

| Category | Prize |
|---|---|
| Web | $50 Amazon voucher |
| Crypto | $50 Amazon voucher |
| Pwn / Rev | $50 Amazon voucher |
| Forensics | $50 Amazon voucher |
| Misc | $50 Amazon voucher |

## First Blood Bonus

The **first team to solve** each challenge earns **+100 bonus points** on top of the challenge's current value.

_Prizes are paid via bank transfer or crypto. Winners must verify identity within 7 days of the event closing._`,
    created_at: Date.now() - 5 * 24 * 3600 * 1000,
  },
  {
    title: 'Our Sponsors',
    body: `HackFest 2026 is made possible by the generous support of our sponsors.

---

### 🏅 Platinum

**CyberStack Solutions** — Enterprise security consulting, red team & blue team services.
[cyberstack.io](https://cyberstack.io)

**SecureNet Labs** — Next-generation vulnerability research and exploit development training.
[securenet.dev](https://securenet.dev)

---

### 🥈 Gold

**BugBounty Pro** — The platform connecting researchers with companies. Earn rewards for real vulnerabilities.
[bugbountypro.com](https://bugbountypro.com)

**PacketCraft** — Deep-packet inspection tools trusted by Fortune 500 security teams.
[packetcraft.io](https://packetcraft.io)

---

### 🥉 Silver

**HexCore Academy** · **NullPointer Community** · **0x41 Security Blog**

---

_Interested in sponsoring future events? Contact us at sponsors@hackfest.io_`,
    created_at: Date.now() - 3 * 24 * 3600 * 1000,
  },
  {
    title: 'Event Schedule & Checkpoints',
    body: `## Timeline

| Time (UTC) | Event |
|---|---|
| Oct 10 · 10:00 | **CTF begins** — all challenges go live |
| Oct 10 · 14:00 | Beginner hint drop — free hints for the three easiest challenges |
| Oct 11 · 10:00 | **24-hour checkpoint** — leaderboard snapshot posted here |
| Oct 11 · 20:00 | Mid-event announcement (may include bonus challenges) |
| Oct 12 · 08:00 | Final two hours — no new registrations |
| Oct 12 · 10:00 | **CTF ends** — flag submission closes |
| Oct 12 · 12:00 | Results verified and announced |
| Oct 13 | Prize distribution begins |

## After the Event

Write-ups are encouraged and welcome — post yours in \`#writeups\` on Discord.
Top-voted write-up per category wins an extra **$25 voucher**.`,
    created_at: Date.now() - 2 * 24 * 3600 * 1000,
  },
];

let announcementsAdded = 0;
const insertAnn = db.prepare('INSERT INTO announcements (title, body, created_at) VALUES (?, ?, ?)');
for (const a of announcements) {
  const exists = db.prepare('SELECT 1 FROM announcements WHERE title = ?').get(a.title);
  if (!exists) {
    insertAnn.run(a.title, a.body, a.created_at);
    announcementsAdded++;
  }
}
console.log(`Announcements: ${announcementsAdded} added (${announcements.length - announcementsAdded} already exist).`);

// ── Dummy users ───────────────────────────────────────────────────────────────

const challenges = db.prepare('SELECT * FROM challenges WHERE visible = 1').all();
if (!challenges.length) {
  console.error('No challenges found. Run `npm run seed` first, then re-run this script.');
  process.exit(1);
}

const byName = Object.fromEntries(challenges.map((c) => [c.name, c]));

// password for all demo accounts: hackfest2026
const DEMO_PASSWORD_HASH = bcrypt.hashSync('hackfest2026', 4);

const players = [
  { username: 'alice_pwn',   email: 'alice@demo.hackfest', solves: ['Welcome', 'Base64 Basics', 'Caesar Salad', 'Regex Flag'] },
  { username: 'b0b_w3b',     email: 'bob@demo.hackfest',   solves: ['Welcome', 'View Source', 'Regex Flag'] },
  { username: 'cr4ck3r',     email: 'cracker@demo.hackfest', solves: ['Welcome', 'Base64 Basics', 'Caesar Salad'] },
  { username: 'x0r_ghost',   email: 'xor@demo.hackfest',   solves: ['Welcome', 'View Source'] },
  { username: 'h4cker_kim',  email: 'kim@demo.hackfest',   solves: ['Welcome', 'Regex Flag'] },
  { username: 'newbie_dev',  email: 'newbie@demo.hackfest', solves: ['Welcome'] },
  { username: 'rev_ninja',   email: 'rev@demo.hackfest',   solves: ['Welcome', 'Base64 Basics', 'View Source'] },
  { username: 'sec_m0nk',    email: 'monk@demo.hackfest',  solves: ['Base64 Basics'] },
];

const insertUser = db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)`);
const insertSolve = db.prepare('INSERT OR IGNORE INTO solves (challenge_id, user_id, team_id, created_at) VALUES (?, ?, NULL, ?)');
const insertSub = db.prepare('INSERT INTO submissions (challenge_id, user_id, team_id, provided, correct, ip, created_at) VALUES (?, ?, NULL, ?, 1, NULL, ?)');

// Spread solves over the last 40 hours to produce an interesting graph
const eventStart = Date.now() - 40 * 3600 * 1000;

let usersAdded = 0;
let solvesAdded = 0;

db.transaction(() => {
  players.forEach((p, pi) => {
    const regTime = eventStart + pi * 18 * 60 * 1000; // stagger registrations
    const info = insertUser.run(p.username, p.email, DEMO_PASSWORD_HASH, regTime);
    if (info.changes > 0) usersAdded++;

    const uid = db.prepare('SELECT id FROM users WHERE username = ?').get(p.username).id;

    p.solves.forEach((name, si) => {
      const ch = byName[name];
      if (!ch) return;
      // Stagger solves: later players take longer per challenge
      const solveTime = regTime + (si + 1) * (30 + pi * 12) * 60 * 1000;
      const existing = db.prepare('SELECT 1 FROM solves WHERE challenge_id = ? AND user_id = ? AND team_id IS NULL').get(ch.id, uid);
      if (!existing) {
        insertSolve.run(ch.id, uid, solveTime);
        insertSub.run(ch.id, uid, `CTF{demo_solve_${name.replace(/\s+/g, '_').toLowerCase()}}`, solveTime);
        solvesAdded++;
      }
    });
  });
})();

console.log(`Users: ${usersAdded} added (${players.length - usersAdded} already exist).`);
console.log(`Solves: ${solvesAdded} added.`);
console.log('\nDemo accounts ready — password for all: hackfest2026');
db.close();

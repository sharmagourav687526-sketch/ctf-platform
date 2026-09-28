# ctf-platform

A self-hosted Capture The Flag platform: player accounts, optional teams, dynamic scoring, a live scoreboard with a score graph, and a full admin panel. Node.js + Express + SQLite; no external services needed.

## Features

**Players**
- Register / login, change password, public profiles with solve history
- Challenge board grouped by category, with filters, solved markers and live solve counts
- Flag submission with per-user rate limiting, optional attempt limits, first-blood messages
- Hints that can cost points, file downloads, connection info (`nc host port`, URLs)
- Individual **or** team play (admin's choice): create a team, share an invite code, shared solves
- Live scoreboard with a step graph of the top 10 over time

**Admins**
- Challenge editor: Markdown descriptions, multiple flags (static or regex, case-insensitive option), hints, file uploads, visibility, prerequisites ("unlocked after solving X")
- Static or **dynamic scoring** (points decay parabolically as more people solve it; everyone's score for it drops together)
- Event window (start/end time), registration toggle, public/private scoreboard, max team size
- User & team management: ban, hide from scoreboard, promote, reset password, delete
- Submissions log with delete (removing a correct one also removes the solve), manual point awards/penalties
- Announcements on the home page, CSV export of scoreboard and submissions

**Security**
- bcrypt password hashing, session fixation protection (session regenerated on login), HttpOnly + SameSite cookies
- CSRF tokens on every state-changing request, strict Content-Security-Policy (no inline scripts/styles), Helmet headers
- Constant-time flag comparison, rate limits on login/register and flag attempts, all SQL parameterised
- Markdown is HTML-escaped *before* formatting; uploads are stored under random names and served as attachments
- CSV export neutralises spreadsheet formula injection

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run seed          # optional: loads a few example challenges
npm start             # http://localhost:3000
```

**The first account you register becomes the admin.** Or create one explicitly:

```bash
npm run create-admin -- alice alice@example.com   # prints a generated password
```

## Docker

```bash
cp .env.example .env
# set SESSION_SECRET in .env  (openssl rand -hex 32)
docker compose up -d --build
```

Data (database + uploads) lives in `./data`. Back that folder up.

### Behind HTTPS

Put nginx, Caddy or Traefik in front and set `TRUST_PROXY=1` so secure cookies and real client IPs work.
Do **not** expose the app directly to the internet over plain HTTP: login cookies would travel unencrypted.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_SECRET` | random in dev, **required** in production | Signs session cookies |
| `PORT` | `3000` | HTTP port |
| `TRUST_PROXY` | off | Number of reverse proxies in front (usually `1`) |
| `DB_FILE` | `./data/ctf.db` | SQLite database path |
| `UPLOAD_DIR` | `./data/uploads` | Challenge file storage |

Everything else (CTF name, mode, times, registration, scoreboard visibility) is in **Admin → Settings**.

## Running a CTF

1. Register the first account (that's your admin), then **Admin → Settings** and pick individual or team mode.
2. **Admin → Challenges → New challenge**. Add hints and files on the edit page after creating it.
3. Set start/end times if you want a scheduled event. Before the start, players see a countdown message; admins can still preview.
4. Post updates under **Admin → Announcements**.

Notes:
- Mode can't be switched after solves exist (solves belong to users or teams). Delete the solves first if you need to.
- Solving is **team-wide** in team mode: once anyone on the team solves a challenge, it counts for everyone on it.
- Dynamic challenges: `Points` is the value at 0 solves, `Minimum` is the floor, `Decay` is the number of solves at which it reaches the floor. Set decay to 0 for a fixed value.

## Development

```bash
npm run dev     # restarts on file changes
npm test        # unit + integration tests (spins up the real app in memory)
```

Layout:

```
src/
  server.js        app factory, security middleware, error handling
  db.js            schema + settings helpers
  scoring.js       dynamic values, scoreboard and graph data
  services/        flag checking, submission/hint transactions
  routes/          auth, challenges, scoreboard+teams, admin
views/             EJS templates       public/   CSS + browser JS
scripts/           seed + create-admin  tests/    node:test suites
```

Notes for contributors: keep all browser JS in `public/js` (the CSP blocks inline scripts), never build HTML from user input with `innerHTML`, and put anything that decides a score inside a transaction.

## Known limitations

- SQLite is single-writer: fine for hundreds of concurrent players, not for a huge public event.
- No email (password reset is done by an admin; email verification isn't implemented).
- Challenge instances are not spawned per team. Host your challenge targets separately and put the address in *Connection info*.
- Run a single instance; sessions and rate limits are stored locally.

## License

MIT

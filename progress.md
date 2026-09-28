# Progress

Last updated: 2026-09-28.

## Status

The platform is built and runs. All 27 automated tests pass (10 unit + 17 integration). A headless-browser walkthrough (login, challenge board, search, flag submission, uploads, scoreboard, admin form, mobile layout) ran with no console or CSP errors, and I reviewed the screenshots. It has **not** been reviewed by a second person, deployed, or load-tested. See "Not done yet" before running a real event.

## Round 2 (visual redesign + interactivity + uploads)

Requested: duller background, no visible upload option for challenges, make it feel like a real interactive CTF site.

- **Look:** animated matrix-rain background (paused for hidden tabs / reduced motion), neon-on-dark glass theme, colour-coded categories, avatars, hero with a typing terminal, animated stat counters.
- **Uploads:** attach files (drag & drop, up to 10 x 50 MB) directly on the *New challenge* form, plus an optional first hint. The edit page keeps its own upload area. Failed validation cleans up orphaned uploads.
- **Admin editor:** live Markdown preview (same renderer players get); dashboard quick-action cards.
- **Players:** progress bar and points earned, search (`/` focuses it), category chips with counts, confetti + toast on a solve, "Solved by" list with first blood, copy button for connection info.
- **Live features:** activity feed (home, scoreboard), toast notifications for other players' solves and first bloods, event countdown in the header, News page with unread badge, scoreboard podium, profile skill bars.
- **Bug found by the new tests:** the file download route read the upload folder from the global config instead of the injected one. Fixed.
- **Bugs found by looking at screenshots:** `hidden` elements were shown when CSS set `display:flex` (empty connection box), the submit button wrapped, and the last chart axis label was clipped. All fixed.

## Stack and decisions

- **Node.js 22 + Express + SQLite** (`better-sqlite3`), server-rendered EJS pages, plain browser JS. No build step.
- **Chosen without asking** (the user said to start working directly): stack, location (`/home/gourav/Desktop/code/Projects/ctf_platform`), and "individual or team mode, chosen by the admin".
- Scores are computed at read time from solve counts, so dynamic-challenge values drop for everyone at once. Nothing is stored per solve.
- The first registered account becomes the admin (`npm run create-admin` also works).
- Strict CSP (no inline scripts or styles), so all browser JS lives in `public/js/`.

## Done

**Backend** (`src/`)
- Schema, settings and SQLite-backed sessions (`db.js`, `sessionStore.js`)
- Scoring: static and dynamic points, hint costs, manual awards, first-to-score tie-break (`scoring.js`)
- Flag submission in one transaction: rate limit (10/min), attempt limits, event window, prerequisites, first blood (`services/ctf.js`); timing-safe static flags and full-match regex flags (`services/flags.js`)
- Auth: register, login, settings/password change, CSRF, login/admin gates (`routes/auth.js`, `middleware.js`)
- Challenges API, hints, file downloads (`routes/challenges.js`)
- Scoreboard + graph data, user/team profiles, team create/join/leave (`routes/scoreboard.js`)
- Admin: challenges (flags, hints, uploads), users, teams, submissions, awards, announcements, settings, CSV exports (`routes/admin.js`)

**Frontend**: 22 EJS views, one stylesheet, scripts for the challenge board and modal, scoreboard table and canvas graph, admin time inputs, and mobile nav.

**Project files**: `package.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `.gitignore`, `.dockerignore`, `README.md`, `scripts/seed.js` (5 sample challenges), `scripts/create-admin.js`.

## Verified

- `npm test`: 10 unit + 14 integration tests, all passing. They cover CSRF, auth gates, dynamic scoring, hints, rate limits, prerequisites, team mode, bans, Markdown sanitising, CSV safety, and every page rendering in user and team mode.
- Real server run on a scratch database: all routes return 200, and the security headers are present.
- Headless Chromium as an admin user: login, 5 challenge cards, filters, modal with code block and hint button, wrong flag then right flag ("First blood +100"), solved marker, scoreboard row and chart legend. No console or CSP errors.

## Not done yet

- **Gemini review.** Gemini CLI is installed but returned `503 high demand` on every attempt (including a full background security-review run in round 2), so it was never used. Security review and second opinions are still owed.
- **Not exercised in a browser:** hint unlock, team mode pages, the admin Users / Submissions / Settings screens (they render in tests but I have not looked at them), the settings date pickers, drag-and-drop with a real mouse drag (file picking was tested).
- **Docker image never built or run.** `docker compose up` is untested.
- **No git repository** yet (the folder is not under version control).
- **Login/register rate limiting is untested**; it is switched off when `NODE_ENV=test`.
- **README has not been read through against the final code.**

## Known limitations and possible follow-ups

- Scoreboard is recomputed on every request. Fine for hundreds of players; add a short cache before a large event.
- SQLite is single-writer; run one instance only.
- No email: password reset is done by an admin, no email verification.
- Challenge targets are not spawned per team; host them separately and put the address in "Connection info".
- Awards in team mode go to the user's team; a user with no team gets an award that scores nowhere.
- Mode (individual/team) cannot be switched once solves exist.
- Ideas not started: challenge import/export, per-category scoreboard, score freeze near the end, bulk user actions, first-blood badges on profiles.

## Environment notes

- `node --test` is broken on this machine's Debian Node build (`Missing internal module 'internal/deps/brace-expansion'`). `npm test` therefore runs each file directly: `node tests/unit.test.js && node tests/app.test.js`.
- Gemini CLI: `/home/gourav/.npm-global/bin/gemini`, v0.59.0, use with `gemini -p "<prompt>"`.
- The test server (port 3111) and its scratch database were only for verification and live in the session scratchpad, not in the project.

## Run it

```bash
cd /home/gourav/Desktop/code/Projects/ctf_platform
npm install
npm run seed      # optional sample challenges
npm start         # http://localhost:3000, first account registered = admin
npm test
```

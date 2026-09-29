#!/usr/bin/env node
'use strict';

// SQLite online backup: safe to run while the platform is live.
// Usage:  node scripts/backup.js [destination]
// Default destination: ./data/backups/ctf-<ISO-timestamp>.db
//
// Cron example (every 5 minutes):
//   */5 * * * * /usr/bin/node /app/scripts/backup.js >> /var/log/ctf-backup.log 2>&1

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ctf.db');
const backupDir = path.join(path.dirname(dbFile), 'backups');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = process.argv[2] || path.join(backupDir, `ctf-${ts}.db`);

fs.mkdirSync(path.dirname(dest), { recursive: true });

const db = new Database(dbFile, { readonly: true });
try {
  db.backup(dest)
    .then(() => {
      console.log(`[${new Date().toISOString()}] Backup written to ${dest}`);
      pruneOldBackups(backupDir);
    })
    .catch((err) => {
      console.error(`[${new Date().toISOString()}] Backup failed:`, err.message);
      process.exit(1);
    });
} finally {
  // backup() is async; db is closed inside the promise chain by better-sqlite3.
}

// Keep the most recent 48 backups; delete the rest.
function pruneOldBackups(dir, keep = 48) {
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('ctf-') && f.endsWith('.db'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return;
  }
  for (const f of files.slice(keep)) {
    fs.rm(path.join(dir, f.name), { force: true }, () => {});
    console.log(`[${new Date().toISOString()}] Pruned old backup: ${f.name}`);
  }
}

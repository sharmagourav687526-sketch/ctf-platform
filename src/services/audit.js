'use strict';

/**
 * Append one row to the admin audit log.
 * All writes are best-effort — a logging failure must never break the actual action.
 */
function log(db, req, action, target = '', detail = '') {
  try {
    db.prepare('INSERT INTO audit_log (admin_id, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, action, String(target), String(detail).slice(0, 500), req.ip || null, Date.now());
  } catch {
    // Non-fatal: logging must never block the real action.
  }
}

module.exports = { log };

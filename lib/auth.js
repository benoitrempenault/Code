'use strict';
const bcrypt = require('bcrypt');
const db = require('./db');

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

async function verifyLogin(email, password) {
  const row = db.prepare('SELECT id, email, password_hash, display_name, role, failed_logins, locked_until, disabled FROM users WHERE email = ?').get(String(email).toLowerCase());
  // Always run bcrypt to mitigate user-enumeration timing differences.
  const dummy = '$2b$12$abcdefghijklmnopqrstuuJ8B6JpVjjGhPjF.2wB.bP4N5z6lJh4yK';
  const hash = row ? row.password_hash : dummy;
  const ok = await bcrypt.compare(password, hash);
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.disabled) return { ok: false, reason: 'disabled' };
  if (row.locked_until && row.locked_until > Date.now()) return { ok: false, reason: 'locked' };
  if (!ok) {
    const failed = (row.failed_logins || 0) + 1;
    const lockedUntil = failed >= LOCK_THRESHOLD ? Date.now() + LOCK_DURATION_MS : null;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failed, lockedUntil, row.id);
    return { ok: false, reason: 'invalid' };
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(row.id);
  return { ok: true, user: { id: row.id, email: row.email, display_name: row.display_name, role: row.role } };
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    // A user disabled mid-session must be evicted at the next request.
    const row = db.prepare('SELECT disabled FROM users WHERE id = ?').get(req.session.user.id);
    if (!row || row.disabled) {
      req.session.destroy(() => {});
      if (req.accepts('html')) return res.redirect('/login');
      return res.status(401).json({ error: 'Account disabled' });
    }
    return next();
  }
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'Authentication required' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Forbidden' });
}

function audit(userId, action, detail, ip) {
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, detail, ip) VALUES (?,?,?,?)').run(userId || null, action, detail || null, ip || null);
  } catch (_) {}
}

module.exports = { verifyLogin, requireAuth, requireAdmin, audit };

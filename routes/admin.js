'use strict';
// Admin pages — managing the ~15 users from the UI instead of via the CLI.
// All routes guarded by requireAdmin in addition to requireAuth (mounted in
// server.js after both are applied).

const express = require('express');
const bcrypt = require('bcrypt');
const { body, param, validationResult } = require('express-validator');
const db = require('../lib/db');
const auth = require('../lib/auth');

const router = express.Router();

router.use(auth.requireAdmin);

router.get('/users', (req, res) => {
  const users = db.prepare(`SELECT id, email, display_name, role, disabled, locked_until, failed_logins, created_at
                            FROM users ORDER BY created_at DESC`).all();
  res.render('admin-users', { users, error: null, ok: req.session.flash && req.session.flash.adminOk || null });
  if (req.session.flash) delete req.session.flash;
});

const passwordRule = (field) => body(field)
  .isString().isLength({ min: 12, max: 256 })
  .withMessage('Mot de passe : 12 caractères minimum');

router.post('/users',
  body('email').isEmail().isLength({ max: 200 }).normalizeEmail(),
  body('display_name').isString().isLength({ min: 1, max: 200 }).trim(),
  body('role').isIn(['user', 'admin']),
  passwordRule('password'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const users = db.prepare('SELECT id, email, display_name, role, disabled, locked_until, failed_logins, created_at FROM users ORDER BY created_at DESC').all();
      return res.status(400).render('admin-users', { users, error: errors.array()[0].msg, ok: null });
    }
    const { email, display_name, role, password } = req.body;
    try {
      const hash = await bcrypt.hash(password, 12);
      const r = db.prepare('INSERT INTO users (email, password_hash, display_name, role) VALUES (?,?,?,?)').run(email, hash, display_name, role);
      auth.audit(req.session.user.id, 'admin_user_create', `id=${r.lastInsertRowid} email=${email} role=${role}`, req.ip);
      req.session.flash = { adminOk: `Utilisateur ${email} créé.` };
    } catch (e) {
      const users = db.prepare('SELECT id, email, display_name, role, disabled, locked_until, failed_logins, created_at FROM users ORDER BY created_at DESC').all();
      return res.status(400).render('admin-users', { users, error: e.message, ok: null });
    }
    res.redirect('/admin/users');
  }
);

function loadTarget(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('Bad id');
  const u = db.prepare('SELECT id, email, role, disabled FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).render('error', { code: 404, message: 'Utilisateur introuvable' });
  req.target = u;
  next();
}

router.post('/users/:id/disable', param('id').isInt(), loadTarget, (req, res) => {
  if (req.target.id === req.session.user.id) {
    req.session.flash = { adminOk: 'Vous ne pouvez pas vous désactiver vous-même.' };
    return res.redirect('/admin/users');
  }
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(req.target.id);
  auth.audit(req.session.user.id, 'admin_user_disable', `id=${req.target.id} email=${req.target.email}`, req.ip);
  req.session.flash = { adminOk: `${req.target.email} désactivé.` };
  res.redirect('/admin/users');
});

router.post('/users/:id/enable', param('id').isInt(), loadTarget, (req, res) => {
  db.prepare('UPDATE users SET disabled = 0, failed_logins = 0, locked_until = NULL WHERE id = ?').run(req.target.id);
  auth.audit(req.session.user.id, 'admin_user_enable', `id=${req.target.id} email=${req.target.email}`, req.ip);
  req.session.flash = { adminOk: `${req.target.email} réactivé.` };
  res.redirect('/admin/users');
});

router.post('/users/:id/unlock', param('id').isInt(), loadTarget, (req, res) => {
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(req.target.id);
  auth.audit(req.session.user.id, 'admin_user_unlock', `id=${req.target.id} email=${req.target.email}`, req.ip);
  req.session.flash = { adminOk: `${req.target.email} déverrouillé.` };
  res.redirect('/admin/users');
});

router.post('/users/:id/role', param('id').isInt(), body('role').isIn(['user', 'admin']), loadTarget, (req, res) => {
  if (req.target.id === req.session.user.id && req.body.role !== 'admin') {
    req.session.flash = { adminOk: 'Vous ne pouvez pas vous retirer le rôle admin vous-même.' };
    return res.redirect('/admin/users');
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, req.target.id);
  auth.audit(req.session.user.id, 'admin_user_role', `id=${req.target.id} role=${req.body.role}`, req.ip);
  req.session.flash = { adminOk: `Rôle de ${req.target.email} : ${req.body.role}.` };
  res.redirect('/admin/users');
});

router.post('/users/:id/reset-password', param('id').isInt(), passwordRule('password'), loadTarget, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.flash = { adminOk: errors.array()[0].msg };
    return res.redirect('/admin/users');
  }
  const hash = await bcrypt.hash(req.body.password, 12);
  db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hash, req.target.id);
  auth.audit(req.session.user.id, 'admin_user_reset_password', `id=${req.target.id} email=${req.target.email}`, req.ip);
  req.session.flash = { adminOk: `Mot de passe de ${req.target.email} réinitialisé.` };
  res.redirect('/admin/users');
});

module.exports = router;

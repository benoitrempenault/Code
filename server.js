'use strict';
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const { csrfSync } = require('csrf-sync');

const db = require('./lib/db');
const auth = require('./lib/auth');

const app = express();

// --- Hardening
const isProd = process.env.NODE_ENV === 'production';
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  hsts: isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
}));

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// --- Sessions (stockées dans SQLite, cookies signés HTTPOnly + SameSite strict)
const sessionsDir = path.join(__dirname, 'data');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('FATAL: SESSION_SECRET is missing or too short. See .env.example');
  process.exit(1);
}

const sessionsDb = new Database(path.join(sessionsDir, 'sessions.db'));
app.use(session({
  store: new SqliteStore({ client: sessionsDb, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
  name: 'eimo.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 * 8, // 8h
  },
}));

// --- CSRF (synchronizer-token pattern). Token exposed via res.locals._csrf.
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => (req.body && req.body._csrf) || req.headers['x-csrf-token'],
});

app.use((req, res, next) => {
  // Generate or refresh token for the session (idempotent).
  res.locals._csrf = generateToken(req);
  res.locals.user = (req.session && req.session.user) || null;
  // Pop flash (one-shot per request)
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  } else {
    res.locals.flash = null;
  }
  next();
});

// --- Rate limiting (global + login-specific)
const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

// --- Views & static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
Object.assign(app.locals, require('./lib/format'));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1d' : 0, index: false, dotfiles: 'deny' }));

// --- Routes (login is public, everything else requires auth + CSRF)
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', loginLimiter, csrfSynchronisedProtection, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || String(email).length > 200 || String(password).length > 256) {
    return res.status(400).render('login', { error: 'Identifiants invalides.' });
  }
  const r = await auth.verifyLogin(email, password);
  if (!r.ok) {
    auth.audit(null, 'login_failed', String(email).toLowerCase(), req.ip);
    const msg = r.reason === 'locked' ? 'Compte temporairement verrouillé. Réessayez plus tard.' : 'Identifiants invalides.';
    return res.status(401).render('login', { error: msg });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('login', { error: 'Erreur de session.' });
    req.session.user = r.user;
    auth.audit(r.user.id, 'login_ok', null, req.ip);
    res.redirect('/');
  });
});

app.post('/logout', csrfSynchronisedProtection, (req, res) => {
  const uid = req.session && req.session.user && req.session.user.id;
  req.session.destroy(() => {
    auth.audit(uid, 'logout', null, req.ip);
    res.clearCookie('eimo.sid');
    res.redirect('/login');
  });
});

// All routes below require auth.
app.use(auth.requireAuth);

app.get('/', (req, res) => {
  const props = db.prepare('SELECT id, label, address, city, postcode, condition, created_at FROM properties WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.session.user.id);
  res.render('dashboard', { props });
});

// API: address autocomplete (BAN). State-changing? No — but apply CSRF anyway since the
// global enforcement below would block GETs without it. We exclude GETs from CSRF.
app.use('/api', apiLimiter);
app.get('/api/address', require('./routes/address'));

// State-changing routes — enforce CSRF.
app.use(csrfSynchronisedProtection);

app.use('/properties', require('./routes/properties'));
app.use('/properties', require('./routes/search'));
app.use('/api/properties', require('./routes/properties-api'));
app.use('/agencies', require('./routes/agencies'));
app.use('/our-sales', require('./routes/our-sales'));
app.use('/import', require('./routes/import'));

// 404 / error handler
app.use((req, res) => res.status(404).render('error', { code: 404, message: 'Page introuvable' }));
app.use((err, req, res, _next) => {
  if (err && err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', { code: 403, message: 'Jeton CSRF invalide. Recharger la page.' });
  }
  console.error('[error]', err);
  res.status(500).render('error', { code: 500, message: 'Erreur serveur' });
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => console.log(`Estimation immo écoute sur http://localhost:${port}`));

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
      // OSM tile servers (a/b/c.tile.openstreetmap.org) for the map widget.
      'img-src': ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],
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

// --- Public share routes (read-only, no auth, no CSRF, tighter rate limit).
//     Mounted before requireAuth so they bypass the login wall.
const shareLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const sharePubl = require('./routes/share');
app.get('/share/:token', shareLimiter, sharePubl.publicView);

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
  // Whitelist sort columns to keep ORDER BY safe even though it's parameterised
  // through a static map (never user-supplied SQL).
  const SORT_COLS = {
    'created_desc': 'created_at DESC',
    'created_asc':  'created_at ASC',
    'label':        "COALESCE(label, address) COLLATE NOCASE ASC",
    'city':         "COALESCE(city, '') COLLATE NOCASE ASC, postcode",
    'condition':    "CASE condition WHEN 'excellent' THEN 1 WHEN 'tres_bon' THEN 2 WHEN 'bon' THEN 3 WHEN 'a_reflechir' THEN 4 ELSE 5 END",
  };
  const sort = SORT_COLS[req.query.sort] || SORT_COLS.created_desc;
  const q = String(req.query.q || '').trim().slice(0, 100);
  const city = String(req.query.city || '').trim().slice(0, 120);
  const cp = String(req.query.cp || '').trim().slice(0, 10);
  const type = ['maison', 'appartement', 'terrain', 'autre'].includes(req.query.type) ? req.query.type : '';
  const cond = ['excellent', 'tres_bon', 'bon', 'a_reflechir'].includes(req.query.condition) ? req.query.condition : '';
  const status = ['prospect', 'mandat_simple', 'mandat_exclusif', 'vendu', 'perdu', 'archive'].includes(req.query.status) ? req.query.status : '';

  const where = ['user_id = ?'];
  const params = [req.session.user.id];
  if (q) {
    where.push('(label LIKE ? OR address LIKE ? OR city LIKE ?)');
    const like = '%' + q.replace(/[%_]/g, (c) => '\\' + c) + '%';
    params.push(like, like, like);
  }
  if (city) { where.push('city LIKE ?'); params.push('%' + city + '%'); }
  if (cp) { where.push('postcode = ?'); params.push(cp); }
  if (type) { where.push('property_type = ?'); params.push(type); }
  if (cond) { where.push('condition = ?'); params.push(cond); }
  if (status) { where.push('status = ?'); params.push(status); }

  const sql = `SELECT id, label, address, city, postcode, property_type, condition, status, created_at, last_searched_at
               FROM properties WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT 200`;
  const props = db.prepare(sql).all(...params);

  // Distinct city / postcode lists (for filter selects), scoped to the user.
  const cities = db.prepare("SELECT DISTINCT city FROM properties WHERE user_id = ? AND city IS NOT NULL AND city != '' ORDER BY city COLLATE NOCASE").all(req.session.user.id).map((r) => r.city);
  const postcodes = db.prepare("SELECT DISTINCT postcode FROM properties WHERE user_id = ? AND postcode IS NOT NULL AND postcode != '' ORDER BY postcode").all(req.session.user.id).map((r) => r.postcode);

  res.render('dashboard', {
    props, cities, postcodes,
    filter: { q, city, cp, type, condition: cond, status, sort: req.query.sort || 'created_desc' },
  });
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
app.use('/admin', require('./routes/admin'));
app.use('/stats', require('./routes/stats'));
app.use('/', sharePubl.router);

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

'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const dbPath = path.join(dataDir, 'app.db');
const db = new Database(dbPath);
const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(schema);
try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
console.log('Database initialised at', dbPath);
db.close();

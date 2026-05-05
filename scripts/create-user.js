'use strict';
// Usage: node scripts/create-user.js <email> <displayName> [role]
// Reads password from stdin (silent if TTY).
const path = require('path');
const readline = require('readline');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

const [, , email, displayName, role = 'user'] = process.argv;
if (!email || !displayName) {
  console.error('Usage: node scripts/create-user.js <email> <displayName> [user|admin]');
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Invalid email');
  process.exit(1);
}
if (!['user', 'admin'].includes(role)) {
  console.error('Role must be "user" or "admin"');
  process.exit(1);
}

const db = new Database(path.join(__dirname, '..', 'data', 'app.db'));

function readPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (process.stdin.isTTY) {
      const stdin = process.stdin;
      process.stdout.write('Password (min 12 chars): ');
      stdin.setRawMode(true);
      let pw = '';
      stdin.resume();
      stdin.setEncoding('utf8');
      stdin.on('data', (ch) => {
        ch = ch.toString('utf8');
        if (ch === '\n' || ch === '\r' || ch === '') {
          stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n');
          rl.close(); resolve(pw);
        } else if (ch === '') { process.exit(1); }
        else if (ch === '') { pw = pw.slice(0, -1); }
        else { pw += ch; }
      });
    } else {
      rl.question('Password: ', (a) => { rl.close(); resolve(a); });
    }
  });
}

(async () => {
  const password = await readPassword();
  if (!password || password.length < 12) {
    console.error('Password must be at least 12 characters');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const r = db.prepare('INSERT INTO users (email, password_hash, display_name, role) VALUES (?,?,?,?)').run(email.toLowerCase(), hash, displayName, role);
    console.log(`Created user id=${r.lastInsertRowid} email=${email} role=${role}`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    db.close();
  }
})();

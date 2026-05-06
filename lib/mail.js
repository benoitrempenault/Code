'use strict';
// Tiny mail wrapper around nodemailer.
//
// Configuration is read from process.env. If SMTP_HOST is not set the
// transport runs in "console" mode: messages are logged to stdout instead of
// being delivered. This makes development and CI safe by default and avoids
// silent failures when the SMTP credentials are missing.

const nodemailer = require('nodemailer');

let cached = null;

function buildTransport() {
  if (cached) return cached;

  const host = process.env.SMTP_HOST;
  if (!host) {
    cached = {
      mode: 'console',
      sendMail({ to, subject, text, html }) {
        console.log('[mail/console] →', to, '|', subject);
        if (text) console.log('[mail/console] text:\n' + text);
        if (html) console.log('[mail/console] html (truncated):\n' + String(html).slice(0, 600));
        return Promise.resolve({ accepted: [to], info: 'console' });
      },
    };
    return cached;
  }

  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = String(process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')) === 'true';
  const t = nodemailer.createTransport({
    host, port, secure,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    tls: { minVersion: 'TLSv1.2' },
  });
  cached = {
    mode: 'smtp',
    sendMail(opts) { return t.sendMail(opts); },
  };
  return cached;
}

function from() {
  return process.env.SMTP_FROM || 'no-reply@estimation-immo.local';
}

async function send({ to, subject, text, html, replyTo }) {
  if (!to || !subject) throw new Error('mail: to and subject required');
  const tr = buildTransport();
  return tr.sendMail({ from: from(), to, subject, text, html, replyTo });
}

function mode() { return buildTransport().mode; }

module.exports = { send, mode };

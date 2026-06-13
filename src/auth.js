// src/auth.js — email/password account logic + session middleware.
//
// Everything here is synchronous (bcrypt's *Sync calls + better-sqlite3),
// matching the project's "no mixing sync/async in the data layer" rule.
//
// AniList OAuth is a SEPARATE login option that lands in src/routes/auth.js
// later; it will reuse createUser/findById here and write to external_accounts.
// OAuth-only accounts carry password_hash = NULL — verifyLogin() below treats
// them as "no password set" and tells the caller to use AniList instead.

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db } = require('./db');

// Work factor for bcrypt. 12 is the current sane default (~250ms/hash on
// commodity hardware) — high enough to be costly to brute-force, low enough
// not to stall the event loop noticeably on a single login.
const BCRYPT_COST = 12;

// ----------------------------------------------------------------------------
// Password hashing
// ----------------------------------------------------------------------------

// hashPassword(plain) -> bcrypt hash string. Called once at signup.
function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

// verifyPassword(plain, hash) -> bool. Called at login. bcrypt.compareSync is
// constant-time for a given hash, so it doesn't leak timing about the password.
function verifyPassword(plain, hash) {
  if (!hash) return false; // OAuth-only account — no local password to match
  return bcrypt.compareSync(plain, hash);
}

// ----------------------------------------------------------------------------
// Validation — returns an array of human-readable error strings (empty = ok).
// Kept deliberately permissive: enough to stop obvious junk, not a gauntlet.
// ----------------------------------------------------------------------------

// Pragmatic email shape check — not RFC-perfect (nothing short of sending mail
// is), just "something@something.tld with no spaces".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Usernames are shown publicly (header, future profile URLs), so restrict to
// url-safe characters and a sane length.
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const PASSWORD_MIN = 8;

function validateSignup({ email, username, password }) {
  const errors = [];
  if (!email || !EMAIL_RE.test(email)) errors.push('Enter a valid email address.');
  if (!username || !USERNAME_RE.test(username)) {
    errors.push('Username must be 3–20 characters: letters, numbers, _ or -.');
  }
  if (!password || password.length < PASSWORD_MIN) {
    errors.push(`Password must be at least ${PASSWORD_MIN} characters.`);
  }
  return errors;
}

// ----------------------------------------------------------------------------
// User records
// ----------------------------------------------------------------------------

// Emails are matched case-insensitively, so we lowercase on the way in and on
// every lookup. Usernames keep their original case for display but the UNIQUE
// constraint is case-sensitive at the DB level — acceptable for v1.
function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

// createUser({email, username, password}) -> the new user row.
// Throws { field, message } on a UNIQUE collision so the route can show a
// field-specific error instead of a 500.
function createUser({ email, username, password }) {
  const now = new Date().toISOString();
  const hash = hashPassword(password);
  try {
    const info = db
      .prepare(
        `INSERT INTO users (email, password_hash, username, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(normalizeEmail(email), hash, String(username).trim(), now);
    return findById(info.lastInsertRowid);
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // better-sqlite3 names the offending column in the message,
      // e.g. "UNIQUE constraint failed: users.email".
      const field = /users\.username/.test(err.message) ? 'username' : 'email';
      throw {
        field,
        message:
          field === 'username'
            ? 'That username is taken.'
            : 'An account with that email already exists.',
      };
    }
    throw err;
  }
}

function findByEmail(email) {
  return db
    .prepare(`SELECT * FROM users WHERE email = ? AND is_active = 1`)
    .get(normalizeEmail(email));
}

function findById(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ? AND is_active = 1`).get(id);
}

// touchLastSeen(id) — stamp last_seen_at on each successful login.
function touchLastSeen(id) {
  db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id
  );
}

// verifyLogin(email, password) -> { user } on success, or { error } describing
// why it failed. Deliberately returns the SAME generic error for "no such
// email" and "wrong password" so we don't confirm which emails are registered.
// The one specific case is an OAuth-only account, where pointing the user at
// AniList is more helpful than a generic failure.
function verifyLogin(email, password) {
  const user = findByEmail(email);
  if (!user) return { error: 'Email or password is incorrect.' };
  if (!user.password_hash) {
    return { error: 'This account uses AniList sign-in. Use the AniList button.' };
  }
  if (!verifyPassword(password, user.password_hash)) {
    return { error: 'Email or password is incorrect.' };
  }
  return { user };
}

// ----------------------------------------------------------------------------
// Express middleware
// ----------------------------------------------------------------------------

// attachUser — runs on every request. Turns req.session.userId into a loaded
// user row on res.locals.user (so EVERY view, including the nav partial, can
// branch on login state) and req.user. Cheap: one indexed PK lookup.
// Self-heals a stale session (user deleted/deactivated) by clearing userId.
function attachUser(req, res, next) {
  res.locals.user = null;
  const id = req.session && req.session.userId;
  if (id) {
    const user = findById(id);
    if (user) {
      req.user = user;
      res.locals.user = user;
    } else {
      delete req.session.userId; // orphaned session — drop it
    }
  }
  next();
}

// csrf — synchronizer-token CSRF protection for every state-changing request.
// We avoid the deprecated `csurf` package: the mechanism is simple enough to
// own. A per-session random token lives in req.session.csrfToken; forms embed
// it in a hidden _csrf field (and future fetch() calls send an X-CSRF-Token
// header). On any unsafe method the submitted token must equal the session
// token, compared in constant time. GET/HEAD/OPTIONS are safe and skipped.
// res.locals.csrfToken is set on every request so views can render the field.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // crypto.timingSafeEqual throws on length mismatch — guard first.
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  if (SAFE_METHODS.has(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('X-CSRF-Token');
  if (!timingSafeEqual(sent, req.session.csrfToken)) {
    return res.status(403).send('Invalid or missing CSRF token. Reload and try again.');
  }
  next();
}

// requireAuth — gate for routes that need a logged-in user (the library,
// profile, list-mutating API calls). Not used yet; wired when those routes
// ship. Remembers where the user was headed so login can bounce them back.
function requireAuth(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

module.exports = {
  hashPassword,
  verifyPassword,
  validateSignup,
  createUser,
  findByEmail,
  findById,
  touchLastSeen,
  verifyLogin,
  attachUser,
  requireAuth,
  csrf,
};

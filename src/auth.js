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

// validateUsername(name) -> error string, or null when it's fine. Shared by
// signup and profile editing so the one rule lives in a single place.
function validateUsername(username) {
  if (!username || !USERNAME_RE.test(username)) {
    return 'Username must be 3–20 characters: letters, numbers, _ or -.';
  }
  return null;
}

function validateSignup({ email, username, password }) {
  const errors = [];
  if (!email || !EMAIL_RE.test(email)) errors.push('Enter a valid email address.');
  const nameErr = validateUsername(username);
  if (nameErr) errors.push(nameErr);
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

// completeOnboarding(id) — stamp onboarding_completed_at so the cold-start quiz
// (views/onboarding.ejs) never shows again. Called once when the user finishes
// OR skips the quiz: a skip leaves the taste vector empty, which the recommender
// already treats as "use the popularity fallback" (see the schema comment on
// users.onboarding_completed_at). The requireOnboarding gate only checks for
// presence, not the value, so an idempotent overwrite is fine.
function completeOnboarding(id) {
  db.prepare(`UPDATE users SET onboarding_completed_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id
  );
}

// updateUsername(id, name) — profile edit. Validate with validateUsername first;
// this throws { field, message } on a UNIQUE collision (same shape createUser
// uses) so the route can show a field-specific message instead of a 500.
function updateUsername(id, username) {
  try {
    db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(
      String(username).trim(),
      id
    );
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw { field: 'username', message: 'That username is taken.' };
    }
    throw err;
  }
}

// updateAvatar(id, value) — set users.avatar to a placeholder key or an upload
// path. The caller is responsible for validating the value (see src/avatar.js).
function updateAvatar(id, value) {
  db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`).run(value, id);
}

// findExternalAccount(userId, provider) — used by the profile page to show
// whether an AniList account is linked. Returns the row or undefined.
function findExternalAccount(userId, provider) {
  return db
    .prepare(`SELECT * FROM external_accounts WHERE user_id = ? AND provider = ?`)
    .get(userId, provider);
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
// AniList OAuth account linking
// ----------------------------------------------------------------------------
// The OAuth callback hands us the viewer's AniList { id, name } plus a token.
// Three cases collapse into one helper:
//   1. Returning AniList user — external_accounts already has this anilistId →
//      refresh the stored token, return the owning user, log them in.
//   2. A logged-in user is linking — sessionUserId is set → attach this AniList
//      account to THAT user (this is our "link if it's really the same person"
//      path; we key on the live session, since AniList gives us no email to
//      match on). Refuses if the AniList account is already linked elsewhere.
//   3. First-time AniList sign-in, no session — auto-create a fresh OAuth-only
//      user (email = NULL, password_hash = NULL), username seeded from the
//      AniList name (suffixed on collision).
//
// Returns the user row to log in. Throws { message } for the one user-facing
// failure (case 2 conflict) so the route can render it.

// AniList usernames don't have to satisfy our USERNAME_RE (3-20, url-safe),
// so sanitize: strip disallowed chars, clamp length, fall back to a generic
// stem, then append -2, -3, … until the UNIQUE(username) constraint is happy.
function uniqueUsernameFrom(rawName) {
  let base = String(rawName || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 20);
  if (base.length < 3) base = 'otaku';
  let candidate = base;
  let n = 1;
  while (db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(candidate)) {
    n += 1;
    const suffix = `-${n}`;
    candidate = base.slice(0, 20 - suffix.length) + suffix;
  }
  return candidate;
}

// Write (or refresh) the external_accounts row for an AniList link. Keyed on
// UNIQUE(user_id, provider), so re-linking the same provider updates the token
// in place rather than duplicating. expiresIn is AniList's seconds-from-now.
function upsertExternalAccount({ userId, anilistId, accessToken, expiresIn }) {
  const now = new Date().toISOString();
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;
  db.prepare(
    `INSERT INTO external_accounts
       (user_id, provider, provider_user_id, access_token, expires_at, connected_at)
     VALUES (?, 'anilist', ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       provider_user_id = excluded.provider_user_id,
       access_token     = excluded.access_token,
       expires_at       = excluded.expires_at`
  ).run(userId, String(anilistId), accessToken, expiresAt, now);
}

function findUserByAnilistId(anilistId) {
  const row = db
    .prepare(
      `SELECT user_id FROM external_accounts
       WHERE provider = 'anilist' AND provider_user_id = ?`
    )
    .get(String(anilistId));
  return row ? findById(row.user_id) : null;
}

function findOrCreateAnilistUser({ anilistId, name, accessToken, expiresIn, sessionUserId }) {
  // Case 1 — this AniList account is already linked to some OtakuGuide user.
  const existing = findUserByAnilistId(anilistId);
  if (existing) {
    // Guard: a logged-in user must not "link" an AniList account owned by a
    // DIFFERENT user — that would hijack the session into the other account.
    // Only block when it's genuinely someone else's; re-linking your own is fine.
    if (sessionUserId && existing.id !== sessionUserId) {
      throw {
        message:
          'That AniList account is already connected to a different OtakuGuide account.',
      };
    }
    // Returning user (or re-linking your own): refresh the token, log them in.
    upsertExternalAccount({ userId: existing.id, anilistId, accessToken, expiresIn });
    return existing;
  }

  // Case 2 — a logged-in user is linking a brand-new AniList account to theirs.
  if (sessionUserId) {
    const me = findById(sessionUserId);
    if (me) {
      upsertExternalAccount({ userId: me.id, anilistId, accessToken, expiresIn });
      return me;
    }
    // sessionUserId pointed at a deleted/disabled user — fall through to create.
  }

  // Case 3 — first-time sign-in, no session. Auto-create an OAuth-only user:
  // email NULL (AniList has none), password_hash NULL (no local login).
  const now = new Date().toISOString();
  const username = uniqueUsernameFrom(name);
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, username, created_at)
       VALUES (NULL, NULL, ?, ?)`
    )
    .run(username, now);
  const user = findById(info.lastInsertRowid);
  upsertExternalAccount({ userId: user.id, anilistId, accessToken, expiresIn });
  return user;
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

// requireOnboarding — runs on every request (mounted globally in server.js,
// right after attachUser). A logged-in user who hasn't finished the cold-start
// quiz is bounced to /onboarding until they pick favorites OR skip; both stamp
// onboarding_completed_at via completeOnboarding(). req.user already carries
// that column (attachUser loads the whole users row).
//
// Three carve-outs let the flow actually complete:
//   - /onboarding   — the quiz page + its POST must be reachable
//   - /api          — the quiz's "more like this" fetch (and any future JSON)
//                     must return data, not an HTML redirect
//   - /logout       — a parked user must still be able to sign out
// And we only intercept GET navigations: a POST (e.g. the quiz submit itself)
// is never redirected out from under the browser.
function requireOnboarding(req, res, next) {
  if (!req.user) return next();
  if (req.user.onboarding_completed_at) return next();
  const p = req.path;
  if (p === '/logout' || p === '/onboarding' || p.startsWith('/api')) return next();
  if (req.method !== 'GET') return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/onboarding');
}

module.exports = {
  hashPassword,
  verifyPassword,
  validateSignup,
  validateUsername,
  createUser,
  findByEmail,
  findById,
  touchLastSeen,
  completeOnboarding,
  updateUsername,
  updateAvatar,
  findExternalAccount,
  verifyLogin,
  findOrCreateAnilistUser,
  attachUser,
  requireAuth,
  requireOnboarding,
  csrf,
};

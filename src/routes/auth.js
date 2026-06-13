// src/routes/auth.js — login / signup / logout (locked architecture:
// pages.js / api.js / auth.js). Email-password lives here now; the AniList
// OAuth routes (/auth/anilist, /auth/anilist/callback) land in this same file
// once credentials exist, reusing the helpers in src/auth.js.
'use strict';

const crypto = require('crypto');
const express = require('express');
const auth = require('../auth');
const anilist = require('../anilist');

const router = express.Router();

const ANILIST_AUTHORIZE_URL = 'https://anilist.co/api/v2/oauth/authorize';

// Is AniList OAuth configured? Without client id/secret/redirect there's
// nothing to bounce to — so we guard the routes and show a clear message
// instead of a broken AniList URL. Unlike SESSION_SECRET we deliberately do
// NOT crash on boot: AniList login is OPTIONAL, email/password works without it.
function anilistConfigured() {
  return Boolean(
    process.env.ANILIST_CLIENT_ID &&
      process.env.ANILIST_CLIENT_SECRET &&
      process.env.ANILIST_REDIRECT_URI
  );
}

// Establish a fresh authenticated session. We regenerate the session id first
// so a token captured before login (session fixation) can't be reused after —
// the standard defense. regenerate() is async (it touches the store), so this
// wraps the callback. returnTo is preserved across the regenerate so a user
// bounced here by requireAuth lands back where they meant to go.
function login(req, userId, done) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return done(err);
    req.session.userId = userId;
    done(null, returnTo || '/');
  });
}

// Logged-in users have no business on these forms — send them home.
function redirectIfAuthed(req, res, next) {
  if (req.user) return res.redirect('/');
  next();
}

// ---- Signup ----------------------------------------------------------------

router.get('/signup', redirectIfAuthed, (req, res) => {
  res.render('signup', { active: '', errors: [], values: {} });
});

router.post('/signup', redirectIfAuthed, (req, res, next) => {
  const email = req.body.email || '';
  const username = req.body.username || '';
  const password = req.body.password || '';

  const errors = auth.validateSignup({ email, username, password });
  if (errors.length) {
    return res.status(400).render('signup', {
      active: '',
      errors,
      values: { email, username },
    });
  }

  let user;
  try {
    user = auth.createUser({ email, username, password });
  } catch (err) {
    if (err && err.field) {
      // UNIQUE collision mapped to a field-specific message in createUser.
      return res.status(409).render('signup', {
        active: '',
        errors: [err.message],
        values: { email, username },
      });
    }
    return next(err);
  }

  login(req, user.id, (err, dest) => {
    if (err) return next(err);
    res.redirect(dest);
  });
});

// ---- Login -----------------------------------------------------------------

router.get('/login', redirectIfAuthed, (req, res) => {
  res.render('login', { active: '', errors: [], values: {} });
});

router.post('/login', redirectIfAuthed, (req, res, next) => {
  const email = req.body.email || '';
  const password = req.body.password || '';

  const { user, error } = auth.verifyLogin(email, password);
  if (error) {
    return res.status(401).render('login', {
      active: '',
      errors: [error],
      values: { email },
    });
  }

  login(req, user.id, (err, dest) => {
    if (err) return next(err);
    auth.touchLastSeen(user.id);
    res.redirect(dest);
  });
});

// ---- Logout ----------------------------------------------------------------
// POST-only: logging out is a state change, so it must not be a bare link a
// prefetcher or <img src> could trigger. The nav renders it as a tiny form.

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('og.sid');
    res.redirect('/');
  });
});

// ---- AniList OAuth ---------------------------------------------------------
// Standard OAuth2 Authorization Code Grant. Step 1 sends the user to AniList's
// consent screen; step 2 is where AniList redirects back with a one-time code.

// Step 1 — bounce to AniList. We mint a random `state`, stash it in the
// session, and AniList echoes it back on the callback; a mismatch there means
// the response didn't come from our redirect (the OAuth CSRF defense).
router.get('/auth/anilist', (req, res) => {
  if (!anilistConfigured()) {
    return res.status(503).render('login', {
      active: '',
      errors: ['AniList sign-in is not configured on this server yet.'],
      values: {},
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url =
    `${ANILIST_AUTHORIZE_URL}?client_id=${encodeURIComponent(process.env.ANILIST_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(process.env.ANILIST_REDIRECT_URI)}` +
    `&response_type=code&state=${state}`;
  res.redirect(url);
});

// Every callback failure ends the same way: back to the login form with a
// human-readable reason. (No flash system in v1, so we render directly.)
function renderCallbackError(res, message, status) {
  return res.status(status).render('login', { active: '', errors: [message], values: {} });
}

// Step 2 — AniList redirects here with ?code & ?state (or ?error if the user
// declined). Verify state, trade the code for a token, fetch the viewer, then
// find-or-create-or-link the account and start a session.
router.get('/auth/anilist/callback', async (req, res, next) => {
  if (!anilistConfigured()) {
    return renderCallbackError(res, 'AniList sign-in is not configured on this server yet.', 503);
  }
  // User denied consent (or AniList errored) — no usable code.
  if (req.query.error || !req.query.code) {
    return renderCallbackError(res, 'AniList sign-in was cancelled.', 400);
  }
  // CSRF: the echoed state must match what we minted, and it's single-use.
  const expected = req.session.oauthState;
  delete req.session.oauthState;
  if (!expected || req.query.state !== expected) {
    return renderCallbackError(res, 'Sign-in could not be verified. Please try again.', 403);
  }

  // Capture the current session user BEFORE login() mints a new session — this
  // is what tells findOrCreateAnilistUser "a logged-in user is LINKING" apart
  // from "a fresh AniList sign-in".
  const sessionUserId = (req.session && req.session.userId) || null;

  try {
    const token = await anilist.exchangeCode(req.query.code);
    const viewer = await anilist.fetchViewer(token.access_token);
    const user = auth.findOrCreateAnilistUser({
      anilistId: viewer.id,
      name: viewer.name,
      accessToken: token.access_token,
      expiresIn: token.expires_in,
      sessionUserId,
    });
    login(req, user.id, (err, dest) => {
      if (err) return next(err);
      auth.touchLastSeen(user.id);
      res.redirect(dest);
    });
  } catch (err) {
    // Our own helpers throw a PLAIN object { message } for expected, user-facing
    // failures (e.g. the AniList account already belongs to someone else); a
    // real Error means something unexpected broke.
    if (err && !(err instanceof Error) && err.message) {
      return renderCallbackError(res, err.message, 409);
    }
    console.error('AniList OAuth callback failed:', err);
    return renderCallbackError(res, 'Could not complete AniList sign-in. Please try again.', 502);
  }
});

module.exports = router;

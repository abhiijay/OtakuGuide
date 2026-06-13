// src/routes/auth.js — login / signup / logout (locked architecture:
// pages.js / api.js / auth.js). Email-password lives here now; the AniList
// OAuth routes (/auth/anilist, /auth/anilist/callback) land in this same file
// once credentials exist, reusing the helpers in src/auth.js.
'use strict';

const express = require('express');
const auth = require('../auth');

const router = express.Router();

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

module.exports = router;

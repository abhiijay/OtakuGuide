// src/routes/api.js — the JSON API (locked architecture: pages.js HTML,
// api.js JSON, auth.js login). v1 surface is the user's anime list: read it,
// add/update an entry, remove one. Every route here needs a logged-in user and
// returns JSON (never an HTML redirect), so it has its own auth guard rather
// than reusing requireAuth (which redirects, the right thing for pages).
//
// CSRF: mutations go through the global csrf middleware (server.js), which
// accepts the token via the X-CSRF-Token header — the form a fetch() caller
// uses. The token is handed to the page in res.locals.csrfToken.

'use strict';

const express = require('express');
const library = require('../library');

const router = express.Router();

// JSON-flavoured auth gate: 401 instead of a redirect to /login.
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

// Parse :animeId once. Anything that isn't a positive integer is a 400 before
// we touch the database.
function parseAnimeId(req, res, next) {
  const id = Number(req.params.animeId);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'animeId must be a positive integer.' });
  }
  req.animeId = id;
  next();
}

router.use(requireUser);

// GET /api/library — the signed-in user's list. Optional ?status= filter.
router.get('/api/library', (req, res) => {
  const status = req.query.status;
  if (status && !library.STATUSES.has(status)) {
    return res.status(400).json({ error: 'Unknown status filter.' });
  }
  res.json({ entries: library.getLibrary(req.user.id, { status }) });
});

// GET /api/library/:animeId — the user's entry for one anime (or null).
router.get('/api/library/:animeId', parseAnimeId, (req, res) => {
  const entry = library.getEntry(req.user.id, req.animeId);
  res.json({ entry: entry || null });
});

// PUT /api/library/:animeId — add or update the entry. Body: status (required)
// plus any of score, episodes_watched, rewatched_count, is_favorite, notes.
router.put('/api/library/:animeId', parseAnimeId, (req, res) => {
  const { error, entry } = library.upsertEntry(req.user.id, req.animeId, req.body || {});
  if (error) {
    // "No anime with that id" is a 404; everything else is bad input (400).
    const status = /No anime/.test(error) ? 404 : 400;
    return res.status(status).json({ error });
  }
  res.json({ entry });
});

// DELETE /api/library/:animeId — remove the entry. 404 if it wasn't on the list.
router.delete('/api/library/:animeId', parseAnimeId, (req, res) => {
  const removed = library.deleteEntry(req.user.id, req.animeId);
  if (!removed) return res.status(404).json({ error: 'Not on your list.' });
  res.json({ ok: true });
});

module.exports = router;

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
const { db } = require('../db');
const {
  recommendFromAnime,
  recommendFromUser,
  titlesAreKin,
  franchiseIds,
} = require('../recommender');
const { largeCover } = require('../covers');

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

// Scope the auth gate to /api — this router is mounted at '/', so a bare
// router.use(requireUser) would 401 EVERY anonymous request (home, catalog,
// all pages), not just the JSON API. The path prefix keeps it to /api/*.
router.use('/api', requireUser);

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

// How many similar titles one expansion reveals.
const SIMILAR_COUNT = 8;

// GET /api/similar/:animeId?exclude=<csv ids> — a handful of anime "more like
// this one", as poster data. Powers the onboarding quiz's Spotify-style
// expansion: pick a title and more like it flow into the same never-ending grid.
// Reuses recommendFromAnime — the same engine behind the anime page's red thread
// — so the suggestions are the real recommendations, not a separate heuristic.
//
// `exclude` is every id already on the page (the picks + everything previously
// revealed). recommendFromAnime already drops the picked anime's OWN franchise;
// here we additionally drop any candidate that belongs to a franchise already on
// the page, so another season never reappears. Two dedup tests, matching how the
// seed grid is built in pages.js:
//   - relations walk (franchiseIds): catches franchise siblings whose names
//     differ ("Gensoumaden Saiyuuki" vs "Saiyuuki Reload") — title alone misses
//     these, and recommendFromAnime's own result set can contain several.
//   - title-kinship (titlesAreKin): the backstop for the cross-id-less twins
//     that carry no relations, where a shared name prefix is all we have.
// We over-fetch (limit 30) and filter down because both passes remove rows.
router.get('/api/similar/:animeId', parseAnimeId, (req, res) => {
  const exclude = new Set(
    String(req.query.exclude || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
  exclude.add(req.animeId); // never suggest the thing they just picked

  const ranked = recommendFromAnime(req.animeId, { limit: 30 });
  const ids = ranked.map((r) => r.id).filter((id) => !exclude.has(id));
  if (!ids.length) return res.json({ similar: [] });

  // Titles already on the page, lowercased, for the kinship test below.
  const ex = [...exclude];
  const shownTitles = db
    .prepare(
      `SELECT title_english, title_romaji FROM anime
        WHERE id IN (${ex.map(() => '?').join(',')})`
    )
    .all(...ex)
    .map((r) => (r.title_english || r.title_romaji || '').toLowerCase())
    .filter(Boolean);

  const rows = db
    .prepare(
      `SELECT id, title_romaji, title_english, cover_image_url
         FROM anime
        WHERE id IN (${ids.map(() => '?').join(',')})
          AND is_adult = 0 AND cover_image_url IS NOT NULL`
    )
    .all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Walk the recommender's ranking order; keep the first SIMILAR_COUNT that
  // clear both dedup tests. `claimed` accumulates the franchise of every id on
  // the page plus every one we keep, so siblings can't pile up within the batch
  // either. franchiseIds is a depth-3 relations walk — bounded to <=30 here, one
  // per considered candidate, which is fine for an occasional per-pick fetch.
  const claimed = new Set(exclude);
  const similar = [];
  for (const id of ids) {
    if (similar.length >= SIMILAR_COUNT) break;
    if (claimed.has(id)) continue;
    const a = byId.get(id);
    if (!a) continue;
    const title = a.title_english || a.title_romaji;
    const lc = (title || '').toLowerCase();
    if (!lc || shownTitles.some((t) => titlesAreKin(lc, t))) continue;

    const fam = franchiseIds(id);
    let clash = false;
    for (const f of fam) {
      if (claimed.has(f)) { clash = true; break; }
    }
    if (clash) continue;

    for (const f of fam) claimed.add(f);
    claimed.add(id);
    shownTitles.push(lc);
    similar.push({
      id: a.id,
      title,
      cover_large: largeCover(a.cover_image_url),
      cover_image_url: a.cover_image_url,
    });
  }
  res.json({ similar });
});

// GET /api/recommendations — personalized "for you", as poster data. Consumes
// the signed-in user's taste vector via recommendFromUser (the engine built for
// exactly this), hydrates each rec into the poster fields a rail/grid needs,
// and preserves the recommender's ranking. Each item carries `score` (taste
// cosine) and `because` ({ id, title, similarity } — the "because you loved X"
// anchor) so the view can explain the pick. Optional ?limit= (1-48, default 24).
//
// No usable taste direction yet (empty list, or positives/negatives that
// cancelled to ~zero) → { recommendations: [] }, which the view reads as
// "onboard or add some shows first", not an error.
router.get('/api/recommendations', (req, res) => {
  let limit = Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 48) limit = 24;

  // Over-fetch a little: dropping cover-less rows below shouldn't starve the
  // grid. The recommender's internal candidate pool is far larger than this,
  // so the extra rows are free.
  const ranked = recommendFromUser(req.user.id, { limit: limit + 8 });
  if (!ranked.length) return res.json({ recommendations: [] });

  const ids = ranked.map((r) => r.id);
  const rows = db
    .prepare(
      `SELECT id, cover_image_url
         FROM anime
        WHERE id IN (${ids.map(() => '?').join(',')})
          AND is_adult = 0 AND cover_image_url IS NOT NULL`
    )
    .all(...ids);
  const covered = new Map(rows.map((r) => [r.id, r.cover_image_url]));

  // Keep the recommender's order, drop anything without a renderable cover,
  // then take the requested count.
  const recommendations = ranked
    .filter((r) => covered.has(r.id))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      title: r.title,
      cover_large: largeCover(covered.get(r.id)),
      cover_image_url: covered.get(r.id),
      score: r.score,
      average_score: r.average_score,
      because: r.because,
    }));
  res.json({ recommendations });
});

module.exports = router;

// src/routes/pages.js — every HTML-returning route (locked architecture:
// pages.js / api.js / auth.js). Routes query via the shared db handle and
// render EJS; no deeper indirection.
'use strict';

const express = require('express');
const { db } = require('../db');
const { recommendFromAnime } = require('../recommender');

const router = express.Router();

// Shared quality filter for curated lists (home page rails/podium):
//   is_adult = 0        — locked decision, no user toggle
//   status = FINISHED   — keeps ranked lists canonical
//   average_score < 9.4 — cuts the score-10 noise band (unreleased titles
//                         with a handful of votes)
// The /catalog browse view deliberately relaxes status/score — browsing
// should show everything; ranking should stay canonical.
const QUALITY =
  `a.is_adult = 0
   AND a.status = 'FINISHED'
   AND a.cover_image_url IS NOT NULL
   AND a.average_score IS NOT NULL
   AND a.average_score < 9.4`;

// MAL serves covers in multiple sizes; the catalog stores the default
// (~225px wide). The 'l' variant (~425px) keeps large renders sharp.
// Some entries lack the variant — img tags fall back via onerror.
function largeCover(url) {
  return url ? url.replace(/\.(jpe?g|png|webp)$/i, 'l.$1') : url;
}

const CATALOG_PAGE_SIZE = 48;
const CATALOG_FORMATS = ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'];
const CATALOG_DECADES = [1960, 1970, 1980, 1990, 2000, 2010, 2020];

// ---------------------------------------------------------------------------
// Home — the three-act poster.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  let stats = null;
  let top = [];
  let rails = [];
  try {
    stats = db.prepare(`SELECT COUNT(*) AS total FROM anime WHERE is_adult = 0`).get();

    top = db
      .prepare(
        `SELECT a.id, title_romaji, title_english, cover_image_url,
                cover_image_xl, banner_image_url,
                season_year, format, average_score, synopsis_mal
         FROM anime a
         WHERE ${QUALITY}
           AND format IN ('TV', 'MOVIE')
           AND episodes >= 1
         ORDER BY average_score DESC
         LIMIT 8`
      )
      .all();
    top.forEach((a) => { a.cover_large = largeCover(a.cover_image_url); });

    // Content rails for the dark act. Genre rails replace/join these once the
    // genre backfill lands; until then we rail on format, era, and tags.
    rails = [
      {
        jp: '映画',
        sub: 'eiga — cinema · the top movies',
        items: db
          .prepare(
            `SELECT a.id, title_romaji, cover_image_url, cover_image_xl, season_year, average_score,
                    format, episodes, substr(synopsis_mal, 1, 180) AS synopsis_snip
             FROM anime a
             WHERE ${QUALITY} AND format = 'MOVIE'
             ORDER BY average_score DESC
             LIMIT 12`
          )
          .all(),
      },
      {
        jp: '九十年代',
        sub: "kyuujuu-nendai — the '90s, when cel ruled",
        items: db
          .prepare(
            `SELECT a.id, title_romaji, cover_image_url, cover_image_xl, season_year, average_score,
                    format, episodes, substr(synopsis_mal, 1, 180) AS synopsis_snip
             FROM anime a
             WHERE ${QUALITY}
               AND season_year BETWEEN 1990 AND 1999
               AND format IN ('TV', 'MOVIE')
             ORDER BY average_score DESC
             LIMIT 12`
          )
          .all(),
      },
      {
        jp: '時間旅行',
        sub: 'jikan ryokou — tagged: time travel',
        items: db
          .prepare(
            `SELECT a.id, a.title_romaji, a.cover_image_url, a.cover_image_xl, a.season_year, a.average_score,
                    a.format, a.episodes, substr(a.synopsis_mal, 1, 180) AS synopsis_snip
             FROM anime a
             JOIN anime_tags at ON at.anime_id = a.id
             JOIN tags t ON t.id = at.tag_id
             WHERE t.name = 'time travel' AND ${QUALITY}
             ORDER BY a.average_score DESC
             LIMIT 12`
          )
          .all(),
      },
    ].filter((rail) => rail.items.length >= 6);
    rails.forEach((rail) =>
      rail.items.forEach((a) => { a.cover_large = largeCover(a.cover_image_url); })
    );
  } catch (err) {
    console.error('home: catalog queries failed, rendering without data —', err.message);
  }
  res.render('home', { active: 'home', stats, top, rails });
});

// ---------------------------------------------------------------------------
// Catalog — browse/search everything. Relaxed filter: browsing shows the
// whole catalog (any status, unscored included); only is_adult and
// missing-cover rows are excluded.
// ---------------------------------------------------------------------------
router.get('/catalog', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const format = CATALOG_FORMATS.includes(req.query.format) ? req.query.format : null;
  const decade = CATALOG_DECADES.includes(Number(req.query.decade)) ? Number(req.query.decade) : null;
  const tag = String(req.query.tag || '').trim().slice(0, 60) || null;
  const genreNames = db.prepare('SELECT name FROM genres ORDER BY name').all().map((g) => g.name);
  const genre = genreNames.includes(req.query.genre) ? req.query.genre : null;
  const sort = ['score', 'year', 'title'].includes(req.query.sort) ? req.query.sort : 'score';
  const pageReq = Math.max(1, parseInt(req.query.page, 10) || 1);

  const where = ['a.is_adult = 0', 'a.cover_image_url IS NOT NULL'];
  const params = [];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(
      `(a.title_romaji LIKE ? ESCAPE '\\' OR a.title_english LIKE ? ESCAPE '\\' OR a.synonyms LIKE ? ESCAPE '\\')`
    );
    params.push(like, like, like);
  }
  if (format) { where.push('a.format = ?'); params.push(format); }
  if (decade) { where.push('a.season_year BETWEEN ? AND ?'); params.push(decade, decade + 9); }
  if (tag) {
    where.push(
      `a.id IN (SELECT at.anime_id FROM anime_tags at JOIN tags t ON t.id = at.tag_id WHERE t.name = ?)`
    );
    params.push(tag);
  }
  if (genre) {
    where.push(
      `a.id IN (SELECT ag.anime_id FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id WHERE g.name = ?)`
    );
    params.push(genre);
  }

  // Score sort demotes unfinished titles and the >= 9.4 noise band (both are
  // pre-release hype votes from tiny samples) below legitimately-scored
  // finished titles instead of hiding them — browsing shows everything,
  // ranking stays honest.
  const ORDER = {
    score: `a.average_score IS NULL, (a.status IS NOT 'FINISHED'), (a.average_score >= 9.4), a.average_score DESC`,
    year: 'a.season_year IS NULL, a.season_year DESC, a.average_score DESC',
    title: 'a.title_romaji COLLATE NOCASE ASC',
  }[sort];

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM anime a WHERE ${where.join(' AND ')}`)
    .get(...params).n;
  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  const page = Math.min(pageReq, pages);

  const items = db
    .prepare(
      `SELECT a.id, a.title_romaji, a.title_english, a.cover_image_url,
              a.season_year, a.format, a.episodes, a.average_score
       FROM anime a
       WHERE ${where.join(' AND ')}
       ORDER BY ${ORDER}
       LIMIT ? OFFSET ?`
    )
    .all(...params, CATALOG_PAGE_SIZE, (page - 1) * CATALOG_PAGE_SIZE);
  items.forEach((a) => { a.cover_large = largeCover(a.cover_image_url); });

  res.render('catalog', {
    active: 'catalog',
    q, format, decade, tag, genre, sort, page, pages, total, items,
    formats: CATALOG_FORMATS,
    decades: CATALOG_DECADES,
    genres: genreNames,
  });
});

// Hydrate recommender output (ids + scores) with display fields,
// preserving rank order. Shared by the detail and discover pages.
function hydrateRecs(ranked) {
  if (!ranked.length) return [];
  const placeholders = ranked.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, title_romaji, cover_image_url, season_year, format, average_score
       FROM anime
       WHERE id IN (${placeholders}) AND is_adult = 0 AND cover_image_url IS NOT NULL`
    )
    .all(...ranked.map((r) => r.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ranked
    .filter((r) => byId.has(r.id))
    .map((r) => ({
      ...byId.get(r.id),
      cover_large: largeCover(byId.get(r.id).cover_image_url),
      match: r.score,
      signals: r.signals,
    }));
}

// ---------------------------------------------------------------------------
// Discover — serendipity mode. A random high-quality seed, its red thread
// drawn from a WIDE candidate pool and shuffled — surprise over rank.
// Reroll = plain GET back to /discover (new random seed server-side).
// ---------------------------------------------------------------------------
router.get('/discover', (req, res) => {
  let seed = null;
  let thread = [];
  try {
    seed = db
      .prepare(
        `SELECT a.id, title_romaji, title_english, cover_image_url, cover_image_xl,
                banner_image_url, season_year, format, episodes, average_score,
                substr(synopsis_mal, 1, 280) AS synopsis_snip
         FROM anime a
         WHERE ${QUALITY} AND a.average_score >= 7.5 AND a.synopsis_vec IS NOT NULL
         ORDER BY RANDOM() LIMIT 1`
      )
      .get();
    if (seed) {
      seed.cover_large = largeCover(seed.cover_image_url);
      const ranked = recommendFromAnime(seed.id, { limit: 40, poolSize: 150 });
      // Fisher-Yates shuffle, then take 18 — the serendipity lean: any of
      // the top-40 matches may surface, not just the safest dozen.
      for (let i = ranked.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [ranked[i], ranked[j]] = [ranked[j], ranked[i]];
      }
      thread = hydrateRecs(ranked.slice(0, 18));
    }
  } catch (err) {
    console.error('discover failed —', err.message);
  }
  res.render('discover', { active: 'discover', seed, thread });
});

// ---------------------------------------------------------------------------
// Anime detail — the profile poster + the red thread (recommendations).
// `story` query param (0–100) is the per-signal weight slider: story vs
// tags share of the merge. Default mirrors DEFAULT_WEIGHTS (0.35/0.25 ≈ 58).
// ---------------------------------------------------------------------------
router.get('/anime/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = Number.isFinite(id)
    ? db.prepare('SELECT * FROM anime WHERE id = ? AND is_adult = 0').get(id)
    : null;
  if (!a) return res.status(404).send('404 — 見つかりません · not found');
  a.cover_large = largeCover(a.cover_image_url);

  const tags = db
    .prepare(
      `SELECT t.name FROM tags t
       JOIN anime_tags at ON at.tag_id = t.id
       WHERE at.anime_id = ? ORDER BY t.name LIMIT 24`
    )
    .all(id)
    .map((r) => r.name);

  const studios = db
    .prepare(
      `SELECT s.name FROM studios s
       JOIN anime_studios ast ON ast.studio_id = s.id
       WHERE ast.anime_id = ? ORDER BY ast.is_main DESC, s.name LIMIT 6`
    )
    .all(id)
    .map((r) => r.name);

  const related = db
    .prepare(
      `SELECT DISTINCT a2.id, a2.title_romaji, a2.cover_image_url, a2.season_year, a2.format
       FROM relations r
       JOIN anime a2 ON a2.id = r.related_anime_id
       WHERE r.anime_id = ? AND a2.is_adult = 0 AND a2.cover_image_url IS NOT NULL
       LIMIT 8`
    )
    .all(id);
  related.forEach((r) => { r.cover_large = largeCover(r.cover_image_url); });

  // 赤い糸 — "more like this" from the live recommender (signals 01+02),
  // weighted by the story↔tags slider.
  const storyRaw = parseInt(req.query.story, 10);
  const storyPct = Number.isFinite(storyRaw) ? Math.min(100, Math.max(0, storyRaw)) : 58;
  let recs = [];
  try {
    const ranked = recommendFromAnime(id, {
      limit: 12,
      weights: { synopsis: storyPct / 100, tags: (100 - storyPct) / 100 },
    });
    recs = hydrateRecs(ranked);
  } catch (err) {
    console.error(`recommendations failed for anime ${id} —`, err.message);
  }

  res.render('anime', { active: '', a, tags, studios, related, recs, storyPct });
});

// ---------------------------------------------------------------------------
// How it works — plain-English docs for the recommender.
// ---------------------------------------------------------------------------
router.get('/how-it-works', (req, res) => {
  res.render('how-it-works', { active: 'docs' });
});

module.exports = router;

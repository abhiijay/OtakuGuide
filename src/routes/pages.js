// src/routes/pages.js — every HTML-returning route (locked architecture:
// pages.js / api.js / auth.js). Routes query via the shared db handle and
// render EJS; no deeper indirection.
'use strict';

const express = require('express');
const { db } = require('../db');
const { recommendFromAnime, franchiseIds, titlesAreKin } = require('../recommender');
const { SIGNALS } = require('../signals');
const { requireAuth, findExternalAccount, completeOnboarding } = require('../auth');
const { PLACEHOLDER_KEYS, placeholderPath } = require('../avatar');
const { profileSummary } = require('../profile');
const { largeCover } = require('../covers');
const library = require('../library');
// Canonical tag spellings for display ("sci fi" → "science fiction") —
// same map the recommender applies at TF-IDF time.
const TAG_ALIASES = require('../../db/tag-aliases.json');

const router = express.Router();

// Shared quality filter for curated lists (home page rails/podium):
//   is_adult = 0        — locked decision, no user toggle
//   status = FINISHED   — keeps ranked lists canonical
//   average_score < 9.4 — cuts the score-10 noise band (unreleased titles
//                         with a handful of votes)
// The /catalog browse view deliberately relaxes status/score — browsing
// should show everything; ranking should stay canonical.
// The anilist_id/mal_id clause is a PROVENANCE floor: ~9K rows exist in
// neither major database, which means (a) the country sweep couldn't verify
// they're Japanese (Kan Kluai, Zhu Xian donghua) and (b) their scores come
// from one obscure source with a handful of votes (clusters of identical
// 9.08s and flat 10.0s). Unverifiable titles stay browsable in /catalog;
// they just can't rank on curated lists.
const QUALITY =
  `a.is_adult = 0
   AND a.status = 'FINISHED'
   AND a.cover_image_url IS NOT NULL
   AND a.average_score IS NOT NULL
   AND a.average_score < 9.4
   AND (a.anilist_id IS NOT NULL OR a.mal_id IS NOT NULL)`;

// Damped score — the Bayesian / IMDb weighted rating, used for ORDER BY on
// every curated list. The MILGRAM incident (2026-06-12): "Milgram Dainishin"
// (a 10-episode music-video SPECIAL, raw score 9.35 from a 2,143-strong
// devoted fanbase, both synopses empty) outscored Frieren on raw average and
// topped the home lists — nothing damped its tiny sample. The Bayesian mean
// pulls a title's score toward the catalog mean C until its popularity
// outweighs the damping mass m:   (pop*score + m*C) / (pop + m).
//   pop = COALESCE(a.popularity, 0)  — AniList popularity / MAL members
//                                       (mixed scales, fine for ranking)
//   C   = mean score across the ranked catalog, computed once at load
//   m   = damping mass. Titles with pop >> m keep their own score; titles
//         with pop <= m collapse toward C. m=5000 sits below every legitimate
//         top title (all pop > 100k → Frieren/FMA:B move < 0.04) and above the
//         noise band (MILGRAM's 2,143 votes → 9.35 damps to 7.13, decisively
//         out of any top-8).
// Damping does NOT replace the >= 9.4 / unfinished demotions in QUALITY and
// the catalog score sort: a hyped unreleased title can carry high popularity,
// which damping alone won't sink — the two guards are complementary.
const DAMP_M = 5000;
let DAMP_C = 6.18; // fallback if the load-time mean query can't run
try {
  const row = db.prepare(`SELECT AVG(average_score) AS c FROM anime a WHERE ${QUALITY}`).get();
  if (row && row.c) DAMP_C = row.c;
} catch (err) {
  console.error('damped-rank: catalog-mean query failed, using fallback C —', err.message);
}
const DAMPED =
  `(COALESCE(a.popularity, 0) * a.average_score + ${DAMP_M} * ${DAMP_C})` +
  ` / (COALESCE(a.popularity, 0) + ${DAMP_M})`;

// largeCover (MAL size-swap for sharp posters) now lives in src/covers.js so
// the JSON API can reuse it; imported above.

const CATALOG_PAGE_SIZE = 48;
const CATALOG_FORMATS = ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'];
const CATALOG_DECADES = [1960, 1970, 1980, 1990, 2000, 2010, 2020];

// Current anime season (WINTER Jan-Mar / SPRING / SUMMER / FALL) — used by
// the home 今季 rail and the /airing board.
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
function currentSeason() {
  const d = new Date();
  return { season: SEASONS[Math.floor(d.getMonth() / 3)], year: d.getFullYear() };
}

// 注目 — draw one random tag and return its shelf's top-scored title
// ("Steins;Gate — best of the memory-manipulation shelf"). Used by the
// home page on every load and by GET /focus for in-place redraws.
// Tags need >= 20 ranked titles so "best of the shelf" is a real claim,
// not the top of a sample of three. The denylist exists because
// tags.is_adult only marks hentai tags — AniDB's cruder descriptor tags
// ("boobs in your face" came up on the third test draw) pass it, and the
// home page is the site's face. Denied tags stay browsable in /catalog
// and search; they just don't get featured.
const FOCUS_TAG_DENY = [
  'boob', 'breast', 'oppai', 'pantsu', 'panties', 'underwear', 'lingerie',
  'fan service', 'fanservice', 'ecchi', 'nudity', 'sex', 'porn', 'fetish',
  'bondage', 'incest', 'masturbat', 'prostitut', 'censor', 'harem',
];

function drawFocusShelf() {
  const focusTag = db
    .prepare(
      `SELECT t.id, t.name, COUNT(*) AS n
       FROM tags t
       JOIN anime_tags at ON at.tag_id = t.id
       JOIN anime a ON a.id = at.anime_id
       WHERE ${QUALITY} AND t.is_adult = 0
         AND ${FOCUS_TAG_DENY.map(() => `t.name NOT LIKE ?`).join(' AND ')}
       GROUP BY t.id
       HAVING COUNT(*) >= 20
       ORDER BY RANDOM()
       LIMIT 1`
    )
    .get(...FOCUS_TAG_DENY.map((w) => `%${w}%`));
  if (!focusTag) return null;

  const feat = db
    .prepare(
      `SELECT a.id, a.title_romaji, a.cover_image_url, a.cover_image_xl,
              a.season_year, a.format, a.average_score
       FROM anime a
       JOIN anime_tags at ON at.anime_id = a.id
       WHERE at.tag_id = ? AND ${QUALITY}
       ORDER BY ${DAMPED} DESC, a.id
       LIMIT 1`
    )
    .get(focusTag.id);
  if (!feat) return null;

  feat.cover_large = largeCover(feat.cover_image_url);
  return {
    feat,
    tag: TAG_ALIASES[focusTag.name] || focusTag.name, // display form
    rawTag: focusTag.name, // exact form for the /catalog?tag= link
    shelfSize: focusTag.n,
  };
}

// ---------------------------------------------------------------------------
// Home — the three-act poster.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  let stats = null;
  let top = [];
  let rails = [];
  let focus = null;
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
         ORDER BY ${DAMPED} DESC
         LIMIT 8`
      )
      .all();
    top.forEach((a) => { a.cover_large = largeCover(a.cover_image_url); });

    // Median score of the ranked catalog — the anchor for the podium's
    // score bars: each bar shows where a title sits between the middle of
    // all anime and a perfect 10 (a fixed, honest scale — the old bars
    // min-max-stretched the 8 visible scores, exaggerating hairline gaps).
    if (stats) {
      stats.scoreMedian = db
        .prepare(
          `SELECT average_score FROM anime a WHERE ${QUALITY}
           ORDER BY average_score
           LIMIT 1 OFFSET (SELECT COUNT(*) FROM anime a WHERE ${QUALITY}) / 2`
        )
        .get().average_score;
    }

    // Content rails for the dark act. Genre rails replace/join these once the
    // genre backfill lands; until then we rail on format, era, and tags.
    //
    // The 今季 rail can't use QUALITY (it requires FINISHED + a score —
    // airing shows have neither). Its own floor: provenance + cover, this
    // season, actually out (RELEASING or FINISHED — never NOT_YET_RELEASED).
    // Sorted by AniList popularity (live via sync-recent) so the rail leads
    // with what people are actually watching, not tiny-sample scores.
    const konki = currentSeason();
    rails = [
      {
        jp: '今季',
        sub: `konki — this season · ${konki.season.toLowerCase()} ${konki.year}, airing now`,
        items: db
          .prepare(
            `SELECT a.id, title_romaji, cover_image_url, cover_image_xl, season_year, average_score,
                    format, episodes, substr(synopsis_mal, 1, 180) AS synopsis_snip
             FROM anime a
             WHERE a.is_adult = 0
               AND a.cover_image_url IS NOT NULL
               AND (a.anilist_id IS NOT NULL OR a.mal_id IS NOT NULL)
               AND a.season = ? AND a.season_year = ?
               AND a.status IN ('RELEASING', 'FINISHED')
             ORDER BY a.popularity DESC NULLS LAST, a.average_score DESC
             LIMIT 24`
          )
          .all(konki.season, konki.year),
      },
      {
        jp: '映画',
        sub: 'eiga — cinema · the top movies',
        items: db
          .prepare(
            `SELECT a.id, title_romaji, cover_image_url, cover_image_xl, season_year, average_score,
                    format, episodes, substr(synopsis_mal, 1, 180) AS synopsis_snip
             FROM anime a
             WHERE ${QUALITY} AND format = 'MOVIE'
             ORDER BY ${DAMPED} DESC
             LIMIT 24`
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
             ORDER BY ${DAMPED} DESC
             LIMIT 24`
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
             ORDER BY ${DAMPED} DESC
             LIMIT 24`
          )
          .all(),
      },
    ].filter((rail) => rail.items.length >= 6);
    rails.forEach((rail) =>
      rail.items.forEach((a) => { a.cover_large = largeCover(a.cover_image_url); })
    );

    focus = drawFocusShelf();
  } catch (err) {
    console.error('home: catalog queries failed, rendering without data —', err.message);
  }
  res.render('home', { active: 'home', stats, top, rails, focus, signals: SIGNALS });
});

// 注目 fragment — focus.js fetches this to redraw the home page's enso
// window in place (the draw-another-shelf button). Returns just the
// partial's HTML; 204 when no draw is possible, which tells the client
// to fall back to a full reload.
router.get('/focus', (req, res) => {
  let focus = null;
  try { focus = drawFocusShelf(); }
  catch (err) { console.error('focus: draw failed —', err.message); }
  if (!focus) return res.status(204).end();
  res.render('partials/focus-window', { focus });
});

// ---------------------------------------------------------------------------
// Airing — the simulcast board. Everything currently RELEASING, split into
// this season's new shows and the continuing carryovers (long-runners,
// multi-cour holdovers). Sorted by live AniList popularity (sync-recent
// keeps it fresh) — what people are actually watching, not tiny-sample
// scores. No QUALITY filter: airing shows aren't FINISHED and often have
// no score yet; the floor here is provenance + cover.
// ---------------------------------------------------------------------------
router.get('/airing', (req, res) => {
  const konki = currentSeason();
  const AIRING_BASE = `
    SELECT a.id, a.title_romaji, a.cover_image_url, a.cover_image_xl,
           a.season_year, a.format, a.episodes, a.average_score
    FROM anime a
    WHERE a.status = 'RELEASING'
      AND a.is_adult = 0
      AND a.cover_image_url IS NOT NULL
      AND (a.anilist_id IS NOT NULL OR a.mal_id IS NOT NULL)`;
  const ORDER = 'ORDER BY a.popularity DESC NULLS LAST, COALESCE(a.average_score, 0) DESC';

  const thisSeason = db
    .prepare(`${AIRING_BASE} AND a.season = ? AND a.season_year = ? ${ORDER}`)
    .all(konki.season, konki.year);
  const continuing = db
    .prepare(`${AIRING_BASE} AND NOT (a.season = ? AND a.season_year = ?) ${ORDER}`)
    .all(konki.season, konki.year);
  [...thisSeason, ...continuing].forEach((a) => {
    a.cover_large = a.cover_image_xl || largeCover(a.cover_image_url);
  });

  res.render('airing', { active: 'airing', konki, thisSeason, continuing });
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
  // Distinct source-material values (signal #7). The list grows on its own
  // while scripts/backfill-source.js fills anime.source; 'Unknown' is MAL's
  // literal no-data marker, as useless for filtering as NULL.
  const sourceNames = db
    .prepare(`SELECT DISTINCT source FROM anime WHERE source IS NOT NULL AND source != 'Unknown' ORDER BY source`)
    .all()
    .map((s) => s.source);
  const source = sourceNames.includes(req.query.source) ? req.query.source : null;
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
  if (source) { where.push('a.source = ?'); params.push(source); }
  // "Newest" means newest RELEASED — an unaired 2033 placeholder topping
  // the list is a press release, not an anime. Airing shows stay; other
  // sorts still browse the full catalog. (IS NOT, not !=, so the ~200
  // unknown-status rows aren't dropped by NULL comparison.)
  if (sort === 'year') { where.push(`a.status IS NOT 'NOT_YET_RELEASED'`); }

  // Score sort demotes unfinished titles and the >= 9.4 noise band (both are
  // pre-release hype votes from tiny samples) below legitimately-scored
  // finished titles instead of hiding them — browsing shows everything,
  // ranking stays honest.
  const ORDER = {
    score: `a.average_score IS NULL, (a.status IS NOT 'FINISHED'), (a.average_score >= 9.4), ${DAMPED} DESC`,
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
    q, format, decade, tag, genre, source, sort, page, pages, total, items,
    formats: CATALOG_FORMATS,
    decades: CATALOG_DECADES,
    genres: genreNames,
    sources: sourceNames,
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
// Onboarding — the cold-start quiz. A new user picks the anime they've loved;
// each pick becomes a COMPLETED + favorite list entry, which the library layer
// turns into the taste vector the personal recommender reads. The global
// requireOnboarding gate (server.js) parks not-yet-onboarded users here; both
// finishing and skipping stamp users.onboarding_completed_at so the gate lets
// them through afterwards.
// ---------------------------------------------------------------------------

// How many posters the initial (no-JS) grid shows. The page grows beyond this
// only with JS, via /api/similar expansion — so this is a real floor of choices
// that works for everyone.
const ONBOARDING_GRID_SIZE = 54;

// onboardingSeeds() — the starting poster set: the most popular catalog titles,
// franchise-deduped so one Naruto shows instead of Naruto + Shippuuden + Boruto.
// We walk the popularity-sorted pool and keep a title only if it isn't already
// claimed by a kept title's franchise (relations walk, signal #12's franchiseIds)
// or a near-identical name (titlesAreKin — the backstop for the cross-id-less
// twins that carry no relations). Over-dedup is harmless here: it just promotes
// the next popular title. Cost: <=54 depth-3 relation walks, once per new user.
function onboardingSeeds() {
  const pool = db
    .prepare(
      `SELECT a.id, a.title_romaji, a.title_english, a.cover_image_url
         FROM anime a
        WHERE ${QUALITY}
        ORDER BY COALESCE(a.popularity, 0) DESC
        LIMIT 200`
    )
    .all();

  const claimed = new Set();
  const keptTitles = [];
  const seeds = [];
  for (const a of pool) {
    if (seeds.length >= ONBOARDING_GRID_SIZE) break;
    if (claimed.has(a.id)) continue;
    const title = (a.title_english || a.title_romaji || '').toLowerCase();
    if (!title) continue;
    if (keptTitles.some((t) => titlesAreKin(title, t))) continue;
    seeds.push({ ...a, cover_large: largeCover(a.cover_image_url) });
    keptTitles.push(title);
    for (const fid of franchiseIds(a.id)) claimed.add(fid);
  }
  return seeds;
}

router.get('/onboarding', requireAuth, (req, res) => {
  // Already done — don't let someone re-run the quiz from a stale link.
  if (req.user.onboarding_completed_at) return res.redirect('/');
  res.render('onboarding', { active: '', seeds: onboardingSeeds() });
});

router.post('/onboarding', requireAuth, (req, res) => {
  // Checkboxes named "pick": urlencoded gives a string for one, an array for
  // many, undefined for none. Normalize to unique positive integer ids.
  let picks = req.body.pick;
  if (picks == null) picks = [];
  else if (!Array.isArray(picks)) picks = [picks];
  const ids = [
    ...new Set(picks.map(Number).filter((n) => Number.isInteger(n) && n > 0)),
  ];

  // Each pick is a COMPLETED favorite — the strongest positive taste signal.
  // upsertEntry recomputes the taste vector on every call (fine at quiz scale)
  // and returns { error } for an id outside the catalog, which we just skip.
  for (const id of ids) {
    library.upsertEntry(req.user.id, id, { status: 'COMPLETED', is_favorite: true });
  }

  // Stamp completion whether they picked or skipped (zero ids) so the gate
  // stops parking them here. Zero picks leaves the taste vector empty, which
  // the recommender already handles as the popularity fallback.
  completeOnboarding(req.user.id);

  const dest = req.session.returnTo || '/';
  delete req.session.returnTo;
  res.redirect(dest);
});

// ---------------------------------------------------------------------------
// How it works — the docs, as a small system of pages. The index holds the
// brief + TLDR + chapter map; each chapter page explains one part of the
// engine in depth (user direction 2026-06-12: not everything in one go).
// Chapters are whitelisted here; unknown slugs 404. Views live in views/docs/.
// ---------------------------------------------------------------------------
const DOC_CHAPTERS = [
  {
    slug: 'library', num: '01', kanji: '蔵書', reading: 'zousho', title: 'The library',
    tease: 'Where the catalog, the two summaries, the tags and the studios come from, and what gets swept out.',
  },
  {
    slug: 'fingerprints', num: '02', kanji: '指紋', reading: 'shimon', title: 'The fingerprints',
    tease: 'How a machine reads a synopsis: meaning turned into 384 numbers, and how two stories are compared.',
  },
  {
    slug: 'signals', num: '03', kanji: '信号', reading: 'shingou', title: 'The signals',
    tease: 'All twelve measurements, what each one knows about a show, and its honest status today.',
  },
  {
    slug: 'ranking', num: '04', kanji: '番付', reading: 'banzuke', title: 'The ranking',
    tease: 'How the votes merge into one list, why a franchise is stopped at the gate, and what the slider does.',
  },
];

router.get('/how-it-works', (req, res) => {
  res.render('how-it-works', { active: 'docs', chapters: DOC_CHAPTERS });
});

router.get('/how-it-works/:slug', (req, res) => {
  const i = DOC_CHAPTERS.findIndex((c) => c.slug === req.params.slug);
  if (i === -1) return res.status(404).send('404 — 見つかりません · not found');
  res.render(`docs/${DOC_CHAPTERS[i].slug}`, {
    active: 'docs',
    chapters: DOC_CHAPTERS,
    chapter: DOC_CHAPTERS[i],
    prev: i > 0 ? DOC_CHAPTERS[i - 1] : null,
    next: i < DOC_CHAPTERS.length - 1 ? DOC_CHAPTERS[i + 1] : null,
    signals: SIGNALS,
  });
});

// Profile — the account's own page (identity + edit). requireAuth bounces
// signed-out visitors to /login. The edit form POSTs to /profile in auth.js,
// which validates, mutates, and redirects back here (post-redirect-get); it
// hands any error / success / repopulated values back via one-shot session
// flash keys that we read and clear here.
router.get('/profile', requireAuth, (req, res) => {
  const flashErrors = req.session.profileErrors || [];
  const flashValues = req.session.profileValues || {};
  const saved = Boolean(req.session.profileSaved);
  delete req.session.profileErrors;
  delete req.session.profileValues;
  delete req.session.profileSaved;

  res.render('profile', {
    active: 'profile',
    anilist: findExternalAccount(req.user.id, 'anilist'),
    placeholders: PLACEHOLDER_KEYS.map((key) => ({ key, src: placeholderPath(key) })),
    summary: profileSummary(req.user.id),
    errors: flashErrors,
    values: flashValues,
    saved,
  });
});

module.exports = router;

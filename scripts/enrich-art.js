// scripts/enrich-art.js — cache premium art for the anime the home page
// displays. Fetches AniList extraLarge covers + wide banner art for the
// podium top-8 and the three content rails, then writes them into
// anime.cover_image_xl / anime.banner_image_url.
//
// This is on-demand CLIENT use of AniList (a handful of batched requests
// for titles we're actively displaying), not bulk collection — the same
// pattern CLAUDE.md sanctions for long-tail synopsis fallback.
//
// Run after an import finishes, or whenever the homepage lists change:
//   npm run enrich:art
// Idempotent: skips titles that already have both URLs cached.
'use strict';

const { db } = require('../src/db');
const { fetchAnimeBatchByIds, ID_BATCH_SIZE } = require('../src/anilist');

// Keep these selections in sync with the home route in server.js.
const QUALITY = `a.is_adult = 0
  AND a.status = 'FINISHED'
  AND a.cover_image_url IS NOT NULL
  AND a.average_score IS NOT NULL
  AND a.average_score < 9.4`;

const CANDIDATES = `
  SELECT id, anilist_id FROM (
    SELECT a.id, a.anilist_id FROM anime a
    WHERE ${QUALITY} AND a.format IN ('TV','MOVIE') AND a.episodes >= 1
    ORDER BY a.average_score DESC LIMIT 8
  )
  UNION
  SELECT id, anilist_id FROM (
    SELECT a.id, a.anilist_id FROM anime a
    WHERE ${QUALITY} AND a.format = 'MOVIE'
    ORDER BY a.average_score DESC LIMIT 12
  )
  UNION
  SELECT id, anilist_id FROM (
    SELECT a.id, a.anilist_id FROM anime a
    WHERE ${QUALITY} AND a.season_year BETWEEN 1990 AND 1999
      AND a.format IN ('TV','MOVIE')
    ORDER BY a.average_score DESC LIMIT 12
  )
  UNION
  SELECT id, anilist_id FROM (
    SELECT a.id, a.anilist_id FROM anime a
    JOIN anime_tags at ON at.anime_id = a.id
    JOIN tags t ON t.id = at.tag_id
    WHERE t.name = 'time travel' AND ${QUALITY}
    ORDER BY a.average_score DESC LIMIT 12
  )
`;

(async () => {
  const rows = db
    .prepare(
      `SELECT id, anilist_id FROM anime
       WHERE id IN (SELECT id FROM (${CANDIDATES}))
         AND anilist_id IS NOT NULL
         AND (cover_image_xl IS NULL OR banner_image_url IS NULL)`
    )
    .all();

  console.log(`enrich-art: ${rows.length} titles need art`);
  if (!rows.length) return;

  const byAnilistId = new Map(rows.map((r) => [r.anilist_id, r.id]));
  const update = db.prepare(
    `UPDATE anime
     SET cover_image_xl = COALESCE(?, cover_image_xl),
         banner_image_url = COALESCE(?, banner_image_url)
     WHERE id = ?`
  );

  const ids = [...byAnilistId.keys()];
  let enriched = 0;
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const batch = await fetchAnimeBatchByIds(ids.slice(i, i + ID_BATCH_SIZE));
    for (const media of batch) {
      const animeId = byAnilistId.get(media.id);
      if (!animeId) continue;
      update.run(media.coverImage?.extraLarge || null, media.bannerImage || null, animeId);
      enriched += 1;
    }
  }
  console.log(`enrich-art: cached art for ${enriched} titles`);
})().catch((err) => {
  console.error('enrich-art failed:', err.message);
  process.exit(1);
});

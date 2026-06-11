// scripts/seed-genres-from-tags.js
// Populates the `genres` and `anime_genres` tables from data we ALREADY
// have in `tags` / `anime_tags`.
//
// Why this works (discovery 2026-06-12):
//   The anime-offline-database snapshot we imported merges each source's
//   genre list (AniList genres, MAL genres, etc.) into one flat `tags`
//   array per anime. So "Action" the GENRE arrived in our DB as the tag
//   'action'. The genres table sat empty only because the import never
//   separated genre-named tags back out — the data itself is here.
//
// Why not backfill from Jikan instead:
//   - This script: instant, zero API calls, covers ~83% of the catalog
//     including the ~10.7K entries that have no MAL ID at all.
//   - Jikan crawl: ~6 hours, and tops out at the 74% of the catalog that
//     has a MAL ID. It can still run later as a refinement pass — MAL's
//     curated genre list per anime is slightly cleaner — but it should
//     not block signal #3.
//
// Canon: AniList's 18-genre list (our catalog is AniList-keyed), spelled
// with the same canonical names as db/tag-aliases.json where they overlap
// ('science fiction', 'magical girl'). Variants merge into one genre.
//
// Idempotent: wipes and rebuilds both tables inside one transaction.
// Run with: node scripts/seed-genres-from-tags.js

'use strict';

const { db } = require('../src/db');

// canonical genre -> tag-name spellings that mean it.
// Variant lists mirror db/tag-aliases.json — anime_tags still holds the
// original spellings (aliases apply at query time, never rewrite rows).
const GENRE_MAP = {
  'Action':          ['action'],
  'Adventure':       ['adventure'],
  'Comedy':          ['comedy'],
  'Drama':           ['drama'],
  'Ecchi':           ['ecchi'],
  'Fantasy':         ['fantasy'],
  'Horror':          ['horror'],
  'Magical Girl':    ['magical girl', 'mahou shoujo'],
  'Mecha':           ['mecha'],
  'Music':           ['music'],
  'Mystery':         ['mystery'],
  'Psychological':   ['psychological'],
  'Romance':         ['romance'],
  'Science Fiction': ['science fiction', 'sci-fi', 'sci fi', 'science-fiction'],
  'Slice of Life':   ['slice of life'],
  'Sports':          ['sports'],
  'Supernatural':    ['supernatural'],
  'Thriller':        ['thriller', 'suspense'],
};

const seed = db.transaction(() => {
  db.prepare('DELETE FROM anime_genres').run();
  db.prepare('DELETE FROM genres').run();

  const insertGenre = db.prepare('INSERT INTO genres (name) VALUES (?)');

  for (const [genreName, variants] of Object.entries(GENRE_MAP)) {
    const genreId = insertGenre.run(genreName).lastInsertRowid;

    // One INSERT...SELECT per genre. DISTINCT collapses anime that carry
    // two spellings of the same genre (e.g. both 'sci-fi' and
    // 'science fiction') into a single (anime_id, genre_id) row.
    const placeholders = variants.map(() => '?').join(', ');
    db.prepare(`
      INSERT INTO anime_genres (anime_id, genre_id)
      SELECT DISTINCT at.anime_id, ?
      FROM anime_tags at
      JOIN tags t ON t.id = at.tag_id
      WHERE t.name IN (${placeholders})
    `).run(genreId, ...variants);
  }
});

seed();

// ---------- report ----------
const rows = db
  .prepare(`
    SELECT g.name, COUNT(ag.anime_id) AS n
    FROM genres g LEFT JOIN anime_genres ag ON ag.genre_id = g.id
    GROUP BY g.id ORDER BY n DESC
  `)
  .all();

const coverage = db
  .prepare(`
    SELECT COUNT(DISTINCT anime_id) AS covered,
           (SELECT COUNT(*) FROM anime) AS total
    FROM anime_genres
  `)
  .get();

console.log('Genres seeded from tags:\n');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(18)} ${r.n.toLocaleString()}`);
}
console.log(
  `\nCoverage: ${coverage.covered.toLocaleString()} of ${coverage.total.toLocaleString()} anime ` +
    `(${((coverage.covered / coverage.total) * 100).toFixed(1)}%) have at least one genre.`,
);

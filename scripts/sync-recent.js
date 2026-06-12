// scripts/sync-recent.js — keeps the NEWEST anime fresh via AniList.
// The offline-database snapshot lags (its "latest" release was 10 weeks
// stale on 2026-06-12), so this script asks AniList directly for the
// previous, current and next season — ~30 small requests, client-scale
// use, nothing like the bulk collection their TOS forbids — and upserts
// what comes back: new titles inserted, volatile fields (status, score,
// popularity, episodes, covers) updated on existing rows. Run any time:
//   npm run sync:recent
// It is also the FINAL data step of `npm run refresh`, deliberately after
// the snapshot import so live AniList data wins over the stale snapshot.
//
// What it does NOT do: synopses and embeddings. Inserted rows keep
// synced_at = NULL, so the next `npm run import -- --refresh` Phase B
// picks them up for Jikan + Wikipedia + embedding. Until then they're
// browsable and the recommender reaches them via tags/genres/studio.
'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { fetchSeasonPage } = require('../src/anilist');

// Background scripts + the dev server share this DB file — wait out short
// write locks instead of crashing on SQLITE_BUSY.
db.pragma('busy_timeout = 10000');

// ---------- season math ----------
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

function seasonOf(date) {
  return { season: SEASONS[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}
function shiftSeason({ season, year }, delta) {
  const i = SEASONS.indexOf(season) + delta;
  return { season: SEASONS[((i % 4) + 4) % 4], year: year + Math.floor(i / 4) };
}

// ---------- vocabulary maps ----------
// AniList MediaSource enum → the Jikan-style strings anime.source already
// holds (see SOURCE_FAMILY in src/recommender.js). Unknown enums → null.
const SOURCE_MAP = {
  ORIGINAL: 'Original', MANGA: 'Manga', LIGHT_NOVEL: 'Light novel',
  VISUAL_NOVEL: 'Visual novel', VIDEO_GAME: 'Game', GAME: 'Game',
  NOVEL: 'Novel', WEB_NOVEL: 'Web novel', DOUJINSHI: 'Doujinshi',
  PICTURE_BOOK: 'Picture book', MULTIMEDIA_PROJECT: 'Mixed media',
  COMIC: 'Other', LIVE_ACTION: 'Other', OTHER: 'Other',
};

// AniList genre names → our genres table's alias-map spellings. Only these
// two differ; the other sixteen match exactly. Genres NOT in our table are
// skipped, never inserted — the 18-genre vocabulary is locked (see the
// genre-id collision post-mortem in CLAUDE.md).
const GENRE_ALIASES = { 'Sci-Fi': 'Science Fiction', 'Mahou Shoujo': 'Magical Girl' };

// Same light tag cleanup as the importer.
function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length < 3) return null;
  return t;
}

// ---------- tombstones (same two sources as import --refresh) ----------
function loadTombstones() {
  const titles = new Set();
  const anilistIds = new Set();
  try {
    const removed = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'db', 'removed-titles.json'), 'utf8'),
    );
    for (const e of removed.entries) titles.add(`${e.title}|${e.season_year ?? ''}`);
  } catch { /* nothing hand-deleted */ }
  try {
    const reportPath = path.join(__dirname, '..', 'db', 'country-sweep-report.jsonl');
    for (const line of fs.readFileSync(reportPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.action === 'deleted-non-jp' && e.anilist_id != null) anilistIds.add(e.anilist_id);
      } catch { /* skip malformed line */ }
    }
  } catch { /* nothing swept yet */ }
  return { titles, anilistIds };
}

// ---------- upsert ----------
const byAnilist = db.prepare('SELECT id, source FROM anime WHERE anilist_id = ?');
const byMal = db.prepare('SELECT id, source FROM anime WHERE mal_id = ?');

// Everything AniList knows better than a stale snapshot. score is 0-100
// on AniList; our column is the 0-10 scale.
const updateLive = db.prepare(`
  UPDATE anime SET
    title_romaji = ?, title_english = ?, title_native = ?,
    cover_image_url = ?, cover_image_xl = ?, banner_image_url = ?,
    format = ?, episodes = ?, duration_minutes = ?,
    season = ?, season_year = ?, status = ?,
    average_score = ?, popularity = ?
  WHERE id = ?
`);
const updateSource = db.prepare(
  `UPDATE anime SET source = ? WHERE id = ? AND source IS NULL`,
);
const insertAnime = db.prepare(`
  INSERT INTO anime (
    anilist_id, mal_id, title_romaji, title_english, title_native,
    cover_image_url, cover_image_xl, banner_image_url,
    format, episodes, duration_minutes, season, season_year, status,
    average_score, popularity, source, is_adult, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
`);

const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
const selectTag = db.prepare('SELECT id FROM tags WHERE name = ?');
const joinTag = db.prepare('INSERT OR IGNORE INTO anime_tags (anime_id, tag_id) VALUES (?, ?)');
const selectGenre = db.prepare('SELECT id FROM genres WHERE name = ?');
const joinGenre = db.prepare('INSERT OR IGNORE INTO anime_genres (anime_id, genre_id) VALUES (?, ?)');
const insertStudio = db.prepare('INSERT OR IGNORE INTO studios (name) VALUES (?)');
const selectStudio = db.prepare('SELECT id FROM studios WHERE name = ?');
const joinStudio = db.prepare(
  'INSERT OR IGNORE INTO anime_studios (anime_id, studio_id, is_main) VALUES (?, ?, ?)',
);

function upsertMedia(m, tombstones, nowStr) {
  if (!m.title?.romaji) return 'skipped';
  if (tombstones.anilistIds.has(m.id)) return 'tombstoned';
  if (tombstones.titles.has(`${m.title.romaji}|${m.seasonYear ?? ''}`)) return 'tombstoned';

  const score = m.averageScore != null ? m.averageScore / 10 : null;
  const source = SOURCE_MAP[m.source] ?? null;

  const existing =
    byAnilist.get(m.id) || (m.idMal != null ? byMal.get(m.idMal) : undefined);

  let animeId;
  let outcome;
  if (existing) {
    animeId = existing.id;
    updateLive.run(
      m.title.romaji, m.title.english ?? null, m.title.native ?? null,
      m.coverImage?.large ?? null, m.coverImage?.extraLarge ?? null, m.bannerImage ?? null,
      m.format ?? null, m.episodes ?? null, m.duration ?? null,
      m.season ?? null, m.seasonYear ?? null, m.status ?? null,
      score, m.popularity ?? null,
      animeId,
    );
    // Never overwrite a Jikan-sourced value — only fill the gap.
    if (source) updateSource.run(source, animeId);
    outcome = 'updated';
  } else {
    const r = insertAnime.run(
      m.id, m.idMal ?? null, m.title.romaji, m.title.english ?? null, m.title.native ?? null,
      m.coverImage?.large ?? null, m.coverImage?.extraLarge ?? null, m.bannerImage ?? null,
      m.format ?? null, m.episodes ?? null, m.duration ?? null,
      m.season ?? null, m.seasonYear ?? null, m.status ?? null,
      score, m.popularity ?? null, source, nowStr,
    );
    animeId = r.lastInsertRowid;
    outcome = 'inserted';
  }

  for (const g of m.genres || []) {
    const row = selectGenre.get(GENRE_ALIASES[g] || g);
    if (row) joinGenre.run(animeId, row.id);
  }
  for (const t of m.tags || []) {
    if (t.isAdult) continue;
    const n = normalizeTag(t.name);
    if (!n) continue;
    insertTag.run(n);
    joinTag.run(animeId, selectTag.get(n).id);
  }
  for (const e of m.studios?.edges || []) {
    if (!e.node?.name) continue;
    insertStudio.run(e.node.name);
    joinStudio.run(animeId, selectStudio.get(e.node.name).id, e.isMain ? 1 : 0);
  }

  return outcome;
}

// ---------- main ----------
(async () => {
  const current = seasonOf(new Date());
  const windows = [shiftSeason(current, -1), current, shiftSeason(current, 1)];
  console.log(
    `sync-recent: ${windows.map((w) => `${w.season} ${w.year}`).join(' / ')} via AniList`,
  );

  const tombstones = loadTombstones();
  const nowStr = new Date().toISOString();
  const counts = { inserted: 0, updated: 0, tombstoned: 0, skipped: 0 };

  for (const w of windows) {
    let page = 1;
    let seasonTotal = 0;
    for (;;) {
      const { media, hasNextPage } = await fetchSeasonPage(w.season, w.year, page);
      db.exec('BEGIN');
      try {
        for (const m of media) counts[upsertMedia(m, tombstones, nowStr)]++;
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      seasonTotal += media.length;
      if (!hasNextPage) break;
      page++;
    }
    console.log(`  ${w.season} ${w.year}: ${seasonTotal} titles (${page} pages)`);
  }

  console.log(
    `sync-recent: COMPLETE — ${counts.inserted} inserted, ${counts.updated} updated, ` +
    `${counts.tombstoned} tombstoned, ${counts.skipped} skipped.`,
  );
  if (counts.inserted > 0) {
    console.log(
      '  new rows have no synopsis yet — the next `npm run import -- --refresh` embeds them.',
    );
  }
  db.close();
})().catch((err) => {
  console.error('sync-recent failed:', err.message);
  process.exit(1);
});

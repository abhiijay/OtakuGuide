// src/profile.js — read-only aggregates for the profile page.
//
// All of this is derived live from the user's real list (user_anime) joined to
// the catalog. Nothing is stored or faked: an empty list yields zeros and empty
// arrays, and the view shows an honest "your list is empty" state. Kept separate
// from src/library.js (the list's write/domain layer, owned alongside the JSON
// API) so the profile's display math doesn't tangle with list mutations.
'use strict';

const { db } = require('./db');
const { largeCover } = require('./covers');

// Order the six statuses read top-to-bottom on the distribution bar / legend.
// Positive engagement first (the sakura end), plan-to-watch last (the faint end).
const STATUS_ORDER = [
  'COMPLETED',
  'WATCHING',
  'REWATCHING',
  'PAUSED',
  'DROPPED',
  'PLANNING',
];

// profileSummary(userId) -> everything the profile page renders about a list.
// One object so the route stays a one-liner. Safe on an empty list.
function profileSummary(userId) {
  // Status counts + episode/time totals in one grouped pass. duration_minutes
  // is NULL for some rows, so fall back to 24 (a TV-episode estimate) — the
  // "days" figure is explicitly an estimate, same as AniList/MAL show.
  const statusRows = db
    .prepare(
      `SELECT ua.status AS status,
              COUNT(*) AS n,
              COALESCE(SUM(ua.episodes_watched), 0) AS eps,
              COALESCE(SUM(ua.episodes_watched * COALESCE(a.duration_minutes, 24)), 0) AS mins
         FROM user_anime ua
         JOIN anime a ON a.id = ua.anime_id
        WHERE ua.user_id = ?
        GROUP BY ua.status`
    )
    .all(userId);

  const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  let total = 0;
  let episodes = 0;
  let minutes = 0;
  for (const r of statusRows) {
    byStatus[r.status] = r.n;
    total += r.n;
    episodes += r.eps;
    minutes += r.mins;
  }

  // Mean score over rated entries only (score is the internal 0-100 scale → /10
  // for the familiar 0-10 display). Unrated entries don't drag the mean down.
  const sc = db
    .prepare(
      `SELECT COUNT(*) AS n, AVG(score) AS avg
         FROM user_anime WHERE user_id = ? AND score IS NOT NULL`
    )
    .get(userId);
  const meanScore = sc.n ? sc.avg / 10 : null;

  // Score histogram bucketed to 1..10 (0-100 → ceil to a 1-10 bin).
  const histRows = db
    .prepare(
      `SELECT MAX(1, (score + 9) / 10) AS bucket, COUNT(*) AS n
         FROM user_anime
        WHERE user_id = ? AND score IS NOT NULL
        GROUP BY bucket`
    )
    .all(userId);
  const histogram = Array.from({ length: 10 }, (_, i) => ({ score: i + 1, n: 0 }));
  for (const h of histRows) {
    if (h.bucket >= 1 && h.bucket <= 10) histogram[h.bucket - 1].n = h.n;
  }
  const histMax = Math.max(1, ...histogram.map((h) => h.n));

  // Top genres across the whole tracked list — the "what you watch" overview.
  const genres = db
    .prepare(
      `SELECT g.name AS name, COUNT(*) AS n
         FROM user_anime ua
         JOIN anime_genres ag ON ag.anime_id = ua.anime_id
         JOIN genres g ON g.id = ag.genre_id
        WHERE ua.user_id = ?
        GROUP BY g.id
        ORDER BY n DESC, g.name
        LIMIT 8`
    )
    .all(userId);
  const genreMax = genres.length ? genres[0].n : 1;

  const favCount = db
    .prepare(`SELECT COUNT(*) AS n FROM user_anime WHERE user_id = ? AND is_favorite = 1`)
    .get(userId).n;

  // Favorites grid (newest first) and the recent-activity feed.
  const favorites = db
    .prepare(
      `SELECT a.id, a.title_romaji, a.cover_image_url, a.cover_image_xl,
              a.season_year, a.format, a.episodes, a.average_score
         FROM user_anime ua
         JOIN anime a ON a.id = ua.anime_id
        WHERE ua.user_id = ? AND ua.is_favorite = 1
        ORDER BY ua.updated_at DESC
        LIMIT 12`
    )
    .all(userId);

  const recent = db
    .prepare(
      `SELECT a.id, a.title_romaji, a.cover_image_url, a.episodes,
              ua.status, ua.score, ua.episodes_watched, ua.updated_at
         FROM user_anime ua
         JOIN anime a ON a.id = ua.anime_id
        WHERE ua.user_id = ?
        ORDER BY ua.updated_at DESC
        LIMIT 6`
    )
    .all(userId);

  for (const f of favorites) f.cover_large = largeCover(f.cover_image_url);

  return {
    total,
    episodes,
    days: minutes / 60 / 24,
    meanScore,
    scoredCount: sc.n,
    favoritesCount: favCount,
    byStatus,
    statusOrder: STATUS_ORDER,
    histogram,
    histMax,
    genres,
    genreMax,
    favorites,
    recent,
  };
}

module.exports = { profileSummary, STATUS_ORDER };

// src/library.js — the user's anime list (user_anime) + taste-vector upkeep.
//
// This is the domain layer behind the JSON API in src/routes/api.js, the same
// way src/auth.js sits behind src/routes/auth.js. Routes validate the request
// shape and translate results to HTTP; the actual SQL and the recommender
// bookkeeping live here.
//
// Everything is synchronous (better-sqlite3), matching the project's
// "no mixing sync/async in the data layer" rule.

'use strict';

const { db } = require('./db');
const { EMBED_DIM } = require('./embeddings');
const { bufferToFloat32, l2Normalize, float32ToBuffer } = require('./recommender');

// The status enum mirrors the CHECK-less convention in the schema comment for
// user_anime.status. Kept here as the single source of truth the API validates
// against (the column itself is plain TEXT, so this is where the contract lives).
const STATUSES = new Set([
  'WATCHING',
  'COMPLETED',
  'DROPPED',
  'PAUSED',
  'PLANNING',
  'REWATCHING',
]);

// ----------------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------------

// getLibrary(userId, { status }) — the user's tracked anime, newest-touched
// first, joined to the display fields a list view needs. `status` is an
// optional filter; an unknown status simply returns nothing (the API rejects
// bad input before it reaches here, but the WHERE stays honest either way).
function getLibrary(userId, { status } = {}) {
  const params = [userId];
  let where = 'ua.user_id = ?';
  if (status) {
    where += ' AND ua.status = ?';
    params.push(status);
  }
  return db
    .prepare(
      `SELECT ua.anime_id, ua.status, ua.score, ua.episodes_watched,
              ua.rewatched_count, ua.is_favorite, ua.started_at, ua.finished_at,
              ua.notes, ua.created_at, ua.updated_at,
              a.title_romaji, a.title_english, a.cover_image_url, a.cover_image_xl,
              a.format, a.episodes, a.season_year, a.average_score
         FROM user_anime ua
         JOIN anime a ON a.id = ua.anime_id
        WHERE ${where}
        ORDER BY ua.updated_at DESC`
    )
    .all(...params);
}

// getEntry(userId, animeId) — the user's single entry for one anime, or
// undefined if it isn't on their list. Lets the anime page show "in your list".
function getEntry(userId, animeId) {
  return db
    .prepare(`SELECT * FROM user_anime WHERE user_id = ? AND anime_id = ?`)
    .get(userId, animeId);
}

// ----------------------------------------------------------------------------
// Writes
// ----------------------------------------------------------------------------

// Coerce/validate the mutable fields. Returns { error } on bad input or a
// clean { values } object. Only fields the caller actually sent are touched,
// so a PUT that changes only `score` doesn't reset `episodes_watched`.
function normalizeFields(body) {
  const out = {};

  // status — required, must be one of the known states.
  if (!body.status || !STATUSES.has(body.status)) {
    return { error: 'status must be one of: ' + [...STATUSES].join(', ') };
  }
  out.status = body.status;

  // score — optional. Internal 0-100 scale (the view converts any 0-10 UI).
  // null/'' explicitly clears a previous rating.
  if (body.score !== undefined) {
    if (body.score === null || body.score === '') {
      out.score = null;
    } else {
      const s = Number(body.score);
      if (!Number.isInteger(s) || s < 0 || s > 100) {
        return { error: 'score must be an integer 0-100, or null' };
      }
      out.score = s;
    }
  }

  if (body.episodes_watched !== undefined) {
    const e = Number(body.episodes_watched);
    if (!Number.isInteger(e) || e < 0) {
      return { error: 'episodes_watched must be a non-negative integer' };
    }
    out.episodes_watched = e;
  }

  if (body.rewatched_count !== undefined) {
    const r = Number(body.rewatched_count);
    if (!Number.isInteger(r) || r < 0) {
      return { error: 'rewatched_count must be a non-negative integer' };
    }
    out.rewatched_count = r;
  }

  if (body.is_favorite !== undefined) {
    out.is_favorite = body.is_favorite ? 1 : 0;
  }

  if (body.notes !== undefined) {
    out.notes = body.notes == null ? null : String(body.notes);
  }

  return { values: out };
}

// upsertEntry(userId, animeId, body) — add or update a list entry, then keep
// the taste vector in step. Returns { error } (bad input / unknown anime) or
// { entry } with the stored row.
//
// started_at / finished_at are managed here, not by the client: starting to
// watch stamps started_at once; reaching COMPLETED stamps finished_at once.
// We never clear them — a later REWATCHING shouldn't erase the first finish.
function upsertEntry(userId, animeId, body) {
  const { error, values } = normalizeFields(body);
  if (error) return { error };

  const now = new Date().toISOString();
  const existing = getEntry(userId, animeId);

  // Merge requested changes over the existing row (or defaults for a new one).
  const row = {
    status: values.status,
    score: 'score' in values ? values.score : existing ? existing.score : null,
    episodes_watched:
      'episodes_watched' in values
        ? values.episodes_watched
        : existing ? existing.episodes_watched : 0,
    rewatched_count:
      'rewatched_count' in values
        ? values.rewatched_count
        : existing ? existing.rewatched_count : 0,
    is_favorite:
      'is_favorite' in values
        ? values.is_favorite
        : existing ? existing.is_favorite : 0,
    notes: 'notes' in values ? values.notes : existing ? existing.notes : null,
    started_at: existing ? existing.started_at : null,
    finished_at: existing ? existing.finished_at : null,
    created_at: existing ? existing.created_at : now,
  };

  // Timestamp transitions.
  if (!row.started_at && row.status !== 'PLANNING') row.started_at = now;
  if (!row.finished_at && row.status === 'COMPLETED') {
    row.finished_at = now;
    if (!row.started_at) row.started_at = now;
  }

  try {
    db.prepare(
      `INSERT INTO user_anime
         (user_id, anime_id, status, score, episodes_watched, rewatched_count,
          is_favorite, started_at, finished_at, notes, created_at, updated_at)
       VALUES (@user_id, @anime_id, @status, @score, @episodes_watched,
               @rewatched_count, @is_favorite, @started_at, @finished_at,
               @notes, @created_at, @updated_at)
       ON CONFLICT(user_id, anime_id) DO UPDATE SET
         status = excluded.status, score = excluded.score,
         episodes_watched = excluded.episodes_watched,
         rewatched_count = excluded.rewatched_count,
         is_favorite = excluded.is_favorite,
         started_at = excluded.started_at, finished_at = excluded.finished_at,
         notes = excluded.notes, updated_at = excluded.updated_at`
    ).run({ user_id: userId, anime_id: animeId, updated_at: now, ...row });
  } catch (err) {
    // The only expected failure is the anime_id FK — a row that isn't in our
    // catalog. Surface it as a clean 404-able error rather than a 500.
    if (err && /FOREIGN KEY/.test(err.message)) {
      return { error: 'No anime with that id.' };
    }
    throw err;
  }

  recomputeTasteVector(userId);
  return { entry: getEntry(userId, animeId) };
}

// deleteEntry(userId, animeId) — remove from the list, then refresh the taste
// vector. Returns true if a row was actually removed.
function deleteEntry(userId, animeId) {
  const info = db
    .prepare(`DELETE FROM user_anime WHERE user_id = ? AND anime_id = ?`)
    .run(userId, animeId);
  if (info.changes > 0) recomputeTasteVector(userId);
  return info.changes > 0;
}

// ----------------------------------------------------------------------------
// Taste vector (implicit feedback + negative signals — recommender spec)
// ----------------------------------------------------------------------------

// tasteWeight(entry) — how strongly, and in which direction, one list entry
// pulls the user's taste vector. This is where "implicit feedback" and
// "negative signals" from the recommender spec become numbers:
//   - An explicit score dominates: 0-100 maps to -1..+1 around the neutral 50,
//     so a 100 pulls toward the show and a 0 pushes away from it.
//   - With no score we infer from status: finishing is a mild positive,
//     dropping a mild negative, planning no signal at all (not watched yet).
//   - A favourite is the strongest deliberate positive; rewatches stack on top
//     (capped, so one obsessive rewatch can't swamp the whole vector).
function tasteWeight(entry) {
  let w;
  if (entry.score != null) {
    w = (entry.score - 50) / 50; // [-1, +1]
  } else {
    switch (entry.status) {
      case 'COMPLETED':
      case 'REWATCHING': w = 0.6; break;
      case 'WATCHING':
      case 'PAUSED':     w = 0.3; break;
      case 'DROPPED':    w = -0.6; break;
      default:           w = 0;   break; // PLANNING
    }
  }
  if (entry.is_favorite) w += 1.0;
  if (entry.rewatched_count > 0) w += Math.min(entry.rewatched_count, 3) * 0.3;
  return w;
}

// recomputeTasteVector(userId) — rebuild and store the user's synopsis taste
// vector from their whole list. Called after every list mutation so the vector
// can never drift out of sync with the list it summarizes.
//
// Math: weighted sum of each watched anime's synopsis_vec (weight from
// tasteWeight above — negatives push away), then L2-normalize back onto the
// unit sphere so it's directly comparable to anime vectors via cosine.
//
// v1 scope: only synopsis_taste_vec is computed. The tag/character/review
// facets stay NULL — tags are TF-IDF (not a stored 384-d embedding) and
// character/review vectors don't exist until v2. They populate when those
// signals land; nothing here fakes them.
//
// Cost: re-reads the user's synopsis_vec blobs on each call. Fine at a personal
// list's scale (hundreds of rows, low-ms). If lists ever grow huge, debounce
// this or move it to a batch job.
function recomputeTasteVector(userId) {
  const rows = db
    .prepare(
      `SELECT ua.status, ua.score, ua.is_favorite, ua.rewatched_count,
              a.synopsis_vec
         FROM user_anime ua
         JOIN anime a ON a.id = ua.anime_id
        WHERE ua.user_id = ? AND a.synopsis_vec IS NOT NULL`
    )
    .all(userId);

  const acc = new Float32Array(EMBED_DIM);
  let contributed = false;
  for (const r of rows) {
    const w = tasteWeight(r);
    if (w === 0) continue;
    const v = bufferToFloat32(r.synopsis_vec);
    for (let i = 0; i < EMBED_DIM; i++) acc[i] += w * v[i];
    contributed = true;
  }

  // Magnitude of the summed vector. If nothing contributed, or the positives
  // and negatives cancelled to ~zero, there's no usable taste direction —
  // store NULL rather than a meaningless zero vector.
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += acc[i] * acc[i];
  norm = Math.sqrt(norm);
  const vecBuf = !contributed || norm < 1e-6 ? null : float32ToBuffer(l2Normalize(acc));

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_vectors (user_id, synopsis_taste_vec, created_at, recomputed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       synopsis_taste_vec = excluded.synopsis_taste_vec,
       recomputed_at = excluded.recomputed_at`
  ).run(userId, vecBuf, now, now);
}

module.exports = {
  STATUSES,
  getLibrary,
  getEntry,
  upsertEntry,
  deleteEntry,
  recomputeTasteVector,
  tasteWeight,
};

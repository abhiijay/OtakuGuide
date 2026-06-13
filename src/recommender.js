// src/recommender.js
// Generates anime recommendations from a multi-signal weighted-sum
// similarity model. v1 starts with signal #1 (synopsis embedding) wired
// end-to-end and grows one signal per commit.
//
// Top-level exports:
//   recommendFromAnime(animeId, opts) — "more like this anime"
//   recommendFromUser(userId, opts)   — personalized "for you" from the taste vector [LIVE]
//
// Roadmap (each commit adds one signal, smoke-tested against real data):
//   #1 synopsis embedding via sqlite-vec       [LIVE]
//   #2 tag TF-IDF (with db/tag-aliases.json)   [LIVE]
//   #3 genre Jaccard overlap                   [LIVE — needs scripts/seed-genres-from-tags.js run once]
//   #4 studio match (IDF-weighted)             [LIVE]
//   #5 era proximity                           [LIVE — refiner, see below]
//   #6 episode-count bucket                    [LIVE — refiner]
//   #7 source material                         [LIVE — refiner; data filling via scripts/backfill-source.js]
//   #8 format kinship                          [LIVE — refiner]
//
// Generators vs refiners:
//   Signals #1-#4 are CANDIDATE GENERATORS — they're sparse enough that
//   "top 100 by this signal" is a meaningful list. Signals #5/#6/#7/#8 are
//   too dense for that (thousands of anime tie at "same year" / "same
//   format", so a 100-row pool would be an arbitrary slice). They run as
//   REFINERS instead: once the generators have produced a merged pool,
//   each candidate gets era/episodes/format scores computed against the
//   query anime directly — deterministic, no pool-cap lottery — and those
//   weighted scores adjust the ranking before the final sort.
//   #9 character vectors                       [needs v2 import]
//   #10 review vectors                         [needs v2 import]
//   #11 popularity + quality re-rank (not a similarity weight)
//   #12 relations-graph filter (not a similarity weight)
//
// All cosine math sits in pure functions at the top so the math layer
// can be unit-tested without a database. The SQL-backed signals come
// after.

'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { EMBED_BYTES, EMBED_DIM } = require('./embeddings');

// =============================================================================
// Config — alias map + default weights
// =============================================================================

// Tag canonicalization for signal #2. Loaded once at module init from
// db/tag-aliases.json. See CLAUDE.md "Tag canonicalization for v1" for the
// decision and the iteration model (edit JSON, restart, no DB writes).
const TAG_ALIASES = (() => {
  const file = path.join(__dirname, '..', 'db', 'tag-aliases.json');
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json.aliases || {};
  } catch (err) {
    console.warn(`[recommender] tag-aliases.json not loaded: ${err.message}`);
    return {};
  }
})();

// Signal weights — initial guess; tune empirically once we can A/B against
// real user-rating feedback. Numbers don't have to sum to 1; the final
// score is rescaled at the merge step.
const DEFAULT_WEIGHTS = Object.freeze({
  synopsis: 0.35, // #1 — the headline signal (CLAUDE.md target: 30-40%)
  tags:     0.25, // #2 — second-heaviest; complements vibe with specifics
  genre:    0.10, // #3 — coarser than tags; one-hot overlap
  studio:   0.08, // #4 — strong style signal in clusters
  era:      0.05, // #5 — numerical, bucketed
  episodes: 0.03, // #6 — short / med / long / movie
  source:   0.04, // #7 — manga / LN / original / etc.
  format:   0.03, // #8 — TV / Movie / OVA / Special
  // #9 (characters) and #10 (reviews) wait for v2 imports.
  // #11 (popularity) is a re-ranker, not a similarity weight.
  // #12 (relations) is a filter, not a similarity weight.
});

// =============================================================================
// Pure vector math — no DB, deterministic, testable in isolation
// =============================================================================

// Reinterpret a 1536-byte Buffer of raw Float32 LE bytes as a Float32Array
// view. Zero-copy — the view shares memory with the buffer.
function bufferToFloat32(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('bufferToFloat32 requires a Buffer');
  }
  if (buf.byteLength !== EMBED_BYTES) {
    throw new Error(`expected ${EMBED_BYTES}-byte Buffer, got ${buf.byteLength}`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, EMBED_DIM);
}

// Copy a Float32Array into a fresh standalone Buffer ready for SQLite.
function float32ToBuffer(f32) {
  if (!(f32 instanceof Float32Array) || f32.length !== EMBED_DIM) {
    throw new Error(`expected ${EMBED_DIM}-dim Float32Array`);
  }
  const buf = Buffer.alloc(EMBED_BYTES);
  const view = new Float32Array(buf.buffer, buf.byteOffset, EMBED_DIM);
  view.set(f32);
  return buf;
}

// Cosine similarity (A·B) / (|A|·|B|). Accepts Float32Array or Buffer.
// Returns a scalar in [-1, 1]. The embedding model outputs unit vectors,
// so |A| = |B| = 1 in practice and this reduces to a dot product — but
// we divide for numerical safety on non-unit inputs (e.g. averaged taste
// vectors before re-normalization).
function cosineSimilarity(a, b) {
  const fa = Buffer.isBuffer(a) ? bufferToFloat32(a) : a;
  const fb = Buffer.isBuffer(b) ? bufferToFloat32(b) : b;
  if (fa.length !== fb.length) {
    throw new Error('cosineSimilarity: vector length mismatch');
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < fa.length; i++) {
    dot += fa[i] * fb[i];
    na  += fa[i] * fa[i];
    nb  += fb[i] * fb[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// L2-normalize a Float32Array in place. Returns the same array for
// chaining. Used after averaging so the result stays on the unit sphere.
function l2Normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  const norm = Math.sqrt(n);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

// Mean of N vectors, re-normalized to unit length. Used to build a "taste
// vector" by averaging the synopsis vectors of anime a user liked. Also
// used inside the import pipeline to merge MAL + Wikipedia synopsis vectors.
function averageVectors(vs) {
  if (!Array.isArray(vs) || vs.length === 0) {
    throw new Error('averageVectors requires a non-empty array');
  }
  const out = new Float32Array(vs[0].length);
  for (const v of vs) {
    if (v.length !== out.length) {
      throw new Error('averageVectors: vector length mismatch');
    }
    for (let i = 0; i < out.length; i++) out[i] += v[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= vs.length;
  return l2Normalize(out);
}

// =============================================================================
// Signal #1 — synopsis embedding similarity (live)
// =============================================================================

// Top-K nearest anime by synopsis_vec cosine distance. vec_distance_cosine
// returns DISTANCE in [0, 2] where 0 = identical direction; we sort ASC
// (most similar first). Excludes the source anime itself, anime without a
// synopsis vector yet, and anime flagged isAdult.
//
// The CTE `q` resolves to a single row holding the query anime's vector.
// SQLite's planner evaluates it once, then the outer query is a single
// pass over the candidate set with one vec_distance_cosine call per row.
// Sub-millisecond at 40K rows on a single CPU.
const SYNOPSIS_NEIGHBORS_SQL = `
  WITH q AS (
    SELECT synopsis_vec
    FROM anime
    WHERE id = ? AND synopsis_vec IS NOT NULL
  )
  SELECT a.id,
         a.title_romaji,
         a.title_english,
         a.average_score,
         vec_distance_cosine(a.synopsis_vec, q.synopsis_vec) AS dist
  FROM anime a, q
  WHERE a.id != ?
    AND a.synopsis_vec IS NOT NULL
    AND a.is_adult = 0
  ORDER BY dist ASC
  LIMIT ?
`;

function neighborsBySynopsis(animeId, limit = 100) {
  return db.prepare(SYNOPSIS_NEIGHBORS_SQL).all(animeId, animeId, limit);
}

// =============================================================================
// Signal #2 — tag TF-IDF similarity (live, with db/tag-aliases.json applied)
// =============================================================================

// Cap IDF to avoid one ultra-rare tag overwhelming the score. log(N/1)
// for a single-anime tag is ~10.6 against our 40K-anime catalog; that
// would let a single match outweigh five common-tag matches. Clamp at 8.
// See CLAUDE.md "Tag canonicalization for v1" / "Signal #2" notes.
const IDF_CEILING = 8;

// Lazy state — built on the first signal-#2 call. The SQLite temp table
// is connection-scoped (better-sqlite3 uses one connection per process),
// so it lives for the lifetime of the process and goes away on exit.
let TAG_RES_READY = false;

// Builds the alias-resolution map + IDF cache, mirrors them to a TEMP
// table so the candidate-scan query can JOIN against them. Idempotent —
// safe to call from every recommendation entry point.
function ensureTagResolution() {
  if (TAG_RES_READY) return;

  // 1. Pull all tag rows. Empty catalog ⇒ nothing to resolve.
  const tagRows = db.prepare('SELECT id, name FROM tags').all();
  if (tagRows.length === 0) {
    TAG_RES_READY = true;
    return;
  }
  const nameToId = new Map();
  for (const t of tagRows) nameToId.set(t.name, t.id);

  // 2. For each tag, decide its canonical_id.
  //    - if t.name is in TAG_ALIASES → look up canonical name's id
  //    - if canonical isn't a known tag yet (import in progress, or no
  //      anime has used the canonical spelling) → fall back to self
  const origToCanonical = new Map();
  for (const t of tagRows) {
    const aliasedName = TAG_ALIASES[t.name];
    const canonicalId = aliasedName ? (nameToId.get(aliasedName) ?? t.id) : t.id;
    origToCanonical.set(t.id, canonicalId);
  }

  // 3. df per canonical_id — sum across all original tags that resolve
  //    to the same canonical. Adult-filtered to match query-side filtering.
  const N = db.prepare('SELECT COUNT(*) AS n FROM anime WHERE is_adult = 0').get().n || 1;
  const dfRows = db.prepare(`
    SELECT at.tag_id, COUNT(DISTINCT at.anime_id) AS df
    FROM anime_tags at
    JOIN anime a ON a.id = at.anime_id
    WHERE a.is_adult = 0
    GROUP BY at.tag_id
  `).all();
  const canonicalDf = new Map();
  for (const r of dfRows) {
    const cId = origToCanonical.get(r.tag_id) ?? r.tag_id;
    canonicalDf.set(cId, (canonicalDf.get(cId) || 0) + r.df);
  }

  // 4. IDF per canonical, clamped at the ceiling.
  const canonicalIdf = new Map();
  for (const [cId, df] of canonicalDf) {
    canonicalIdf.set(cId, Math.min(Math.log(N / df), IDF_CEILING));
  }

  // 5. Mirror (orig_id → canonical_id, idf) into a temp table the SQL
  //    candidate-scan can JOIN against. IF NOT EXISTS guards against
  //    a leftover from a prior call inside the same connection.
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS tag_resolution(
      orig_id      INTEGER PRIMARY KEY,
      canonical_id INTEGER NOT NULL,
      idf          REAL    NOT NULL
    );
    DELETE FROM tag_resolution;
  `);
  const insert = db.prepare('INSERT INTO tag_resolution(orig_id, canonical_id, idf) VALUES (?, ?, ?)');
  const insertMany = db.transaction((rows) => {
    for (const [origId, canonicalId] of rows) {
      const idf = canonicalIdf.get(canonicalId) ?? 0;
      insert.run(origId, canonicalId, idf);
    }
  });
  insertMany([...origToCanonical.entries()]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tag_res_canonical ON tag_resolution(canonical_id)');

  TAG_RES_READY = true;
}

// Top-K nearest anime by aggregated TF-IDF of shared *canonical* tags.
//
// Score = Σ IDF(c) over canonical tags c the candidate shares with the
// query anime. The inner GROUP BY at.anime_id, tr.canonical_id is the
// dedupe step that prevents a candidate from double-scoring when it has
// multiple alias spellings of the same canonical (e.g. `sci-fi` AND
// `science fiction` both present on the same anime → one count).
function neighborsByTags(animeId, limit = 100) {
  ensureTagResolution();

  // Distinct canonical tag set for the query anime.
  const queryCanonicals = db.prepare(`
    SELECT DISTINCT tr.canonical_id, tr.idf
    FROM anime_tags at
    JOIN tag_resolution tr ON tr.orig_id = at.tag_id
    WHERE at.anime_id = ?
  `).all(animeId);

  if (queryCanonicals.length === 0) return [];

  const canonicalIds = queryCanonicals.map((q) => q.canonical_id);
  const placeholders = canonicalIds.map(() => '?').join(',');

  return db.prepare(`
    WITH per_candidate AS (
      SELECT at.anime_id, tr.canonical_id, MAX(tr.idf) AS idf
      FROM anime_tags at
      JOIN tag_resolution tr ON tr.orig_id = at.tag_id
      WHERE tr.canonical_id IN (${placeholders})
        AND at.anime_id != ?
      GROUP BY at.anime_id, tr.canonical_id
    )
    SELECT a.id, a.title_romaji, a.title_english, a.average_score,
           SUM(pc.idf) AS tag_score
    FROM per_candidate pc
    JOIN anime a ON a.id = pc.anime_id
    WHERE a.is_adult = 0
    GROUP BY a.id
    ORDER BY tag_score DESC
    LIMIT ?
  `).all(...canonicalIds, animeId, limit);
}

// =============================================================================
// Signal #3 — genre Jaccard overlap (live)
// =============================================================================

// Top-K nearest anime by Jaccard similarity over genre sets:
//
//   score = |shared genres| / |union of both genre sets|
//         = shared / (query_count + candidate_count - shared)
//
// Why Jaccard instead of another TF-IDF sum like signal #2:
//   - Bounded [0, 1]. A candidate slathered in 8 genres can't outscore a
//     tight 2-for-2 match just by surface area — the union term in the
//     denominator punishes genre-spam.
//   - Deliberately a DIFFERENT shape of opinion than tags. Genres also
//     exist as tags, so re-running TF-IDF here would mostly double-count
//     signal #2. Jaccard asks "how much of your identity overlaps with
//     mine," which tags' unbounded sum does not.
//
// With only 18 genres, exact-score ties are common (thousands of pairs
// share {Action, Comedy} perfectly). Ties break toward higher community
// rating so the LIMIT slice is deterministic and quality-leaning.
function neighborsByGenres(animeId, limit = 100) {
  const queryCount = db.prepare(
    'SELECT COUNT(*) AS n FROM anime_genres WHERE anime_id = ?'
  ).get(animeId).n;

  if (queryCount === 0) return [];

  return db.prepare(`
    WITH q AS (
      SELECT genre_id FROM anime_genres WHERE anime_id = ?
    ),
    shared AS (
      SELECT ag.anime_id, COUNT(*) AS n_shared
      FROM anime_genres ag
      JOIN q ON q.genre_id = ag.genre_id
      WHERE ag.anime_id != ?
      GROUP BY ag.anime_id
    ),
    sizes AS (
      SELECT anime_id, COUNT(*) AS n_total
      FROM anime_genres
      GROUP BY anime_id
    )
    SELECT a.id, a.title_romaji, a.title_english, a.average_score,
           CAST(s.n_shared AS REAL) / (? + z.n_total - s.n_shared) AS genre_score
    FROM shared s
    JOIN sizes z ON z.anime_id = s.anime_id
    JOIN anime a ON a.id = s.anime_id
    WHERE a.is_adult = 0
    ORDER BY genre_score DESC, COALESCE(a.average_score, 0) DESC
    LIMIT ?
  `).all(animeId, animeId, queryCount, limit);
}

// =============================================================================
// Signal #4 — studio match, IDF-weighted (live)
// =============================================================================

// Top-K anime sharing at least one ANIMATION studio with the query anime
// (licensors/producers carry is_animation_studio = 0 and are excluded —
// sharing a distributor says nothing about style).
//
// Score = (Σ IDF over SHARED studios) / (Σ IDF over the QUERY's studios)
// where IDF = min(ln(N / df), 8) — same logic as signal #2, because studio
// prevalence varies hugely: sharing Toei (thousands of titles) is weak
// evidence of kinship; sharing ufotable (dozens) is strong.
//
// Dividing by the query's own total makes the score an ABSOLUTE fraction
// in (0, 1]: "how much of this anime's studio identity does the candidate
// share?" That matters at merge time — most anime have exactly one
// animation studio, so the whole candidate pool often ties at the same
// raw score, and min-max normalization would collapse a constant pool to
// zero (erasing the signal entirely). An absolute score skips min-max,
// like the categorical refiners.
function neighborsByStudio(animeId, limit = 100) {
  const queryStudios = db.prepare(`
    SELECT ast.studio_id
    FROM anime_studios ast
    JOIN studios s ON s.id = ast.studio_id
    WHERE ast.anime_id = ? AND s.is_animation_studio = 1
  `).all(animeId).map((r) => r.studio_id);

  if (queryStudios.length === 0) return [];

  const N = db.prepare('SELECT COUNT(*) AS n FROM anime WHERE is_adult = 0').get().n || 1;
  const placeholders = queryStudios.map(() => '?').join(',');

  return db.prepare(`
    WITH df AS (
      SELECT ast.studio_id, COUNT(DISTINCT ast.anime_id) AS df,
             min(ln(CAST(? AS REAL) / COUNT(DISTINCT ast.anime_id)), 8.0) AS idf
      FROM anime_studios ast
      WHERE ast.studio_id IN (${placeholders})
      GROUP BY ast.studio_id
    ),
    qtotal AS (
      SELECT SUM(idf) AS total FROM df
    )
    SELECT a.id, a.title_romaji, a.title_english, a.average_score,
           SUM(df.idf) / (SELECT total FROM qtotal) AS studio_score
    FROM anime_studios ast
    JOIN df ON df.studio_id = ast.studio_id
    JOIN anime a ON a.id = ast.anime_id
    WHERE ast.anime_id != ?
      AND a.is_adult = 0
    GROUP BY a.id
    ORDER BY studio_score DESC, COALESCE(a.average_score, 0) DESC
    LIMIT ?
  `).all(N, ...queryStudios, animeId, limit);
}

// =============================================================================
// Signals #5 / #6 / #7 / #8 — categorical refiners (era, episodes, source, format)
// =============================================================================

// Era (#5): triangular decay over two decades. Same year scores 1, each
// year of distance costs 0.05, twenty-plus years apart scores 0. Plain
// English: a 1998 and a 2003 anime share an era (0.75); a 1998 and a
// 2024 anime do not (0).
function eraScore(yearA, yearB) {
  if (yearA == null || yearB == null) return 0;
  return Math.max(0, 1 - Math.abs(yearA - yearB) / 20);
}

// Episodes (#6): compare commitment-size buckets, not raw counts — the
// difference between 12 and 13 episodes is nothing, the difference
// between 12 and 500 is the whole viewing experience.
//   0: single (1)        — movies, one-shot OVAs
//   1: mini (2-7)        — short OVA series
//   2: one cour (8-13)
//   3: two cour (14-26)
//   4: long (27-64)      — year-ish runs
//   5: epic (65+)        — One Piece territory
// Same bucket = 1, adjacent = 0.5, further = 0.
function episodeBucket(n) {
  if (n == null || n <= 0) return null;
  if (n === 1) return 0;
  if (n <= 7) return 1;
  if (n <= 13) return 2;
  if (n <= 26) return 3;
  if (n <= 64) return 4;
  return 5;
}

function episodesScore(epsA, epsB) {
  const a = episodeBucket(epsA);
  const b = episodeBucket(epsB);
  if (a === null || b === null) return 0;
  const d = Math.abs(a - b);
  return d === 0 ? 1 : d === 1 ? 0.5 : 0;
}

// Source material (#7): exact match = 1; same family = 0.5. "Adapted from
// a manga" and "adapted from a web manga" are near-identical pedigrees;
// "light novel" and "visual novel" are not (one is prose, one is a game).
// Families: manga-likes, prose novels, games. Original / Music / Other /
// etc. stand alone. Jikan's literal 'Unknown' carries no information and
// scores 0, same as missing.
//
// Data dependency: anime.source fills via scripts/backfill-source.js
// (~4.5h Jikan crawl, resumable). Until a row has a source, this scores 0
// for it — the signal strengthens automatically as the backfill lands.
const SOURCE_FAMILY = {
  'Manga': 'manga', 'Web manga': 'manga', '4-koma manga': 'manga',
  'Light novel': 'novel', 'Novel': 'novel', 'Web novel': 'novel', 'Book': 'novel',
  'Game': 'game', 'Visual novel': 'game', 'Card game': 'game',
};

function sourceScore(srcA, srcB) {
  if (!srcA || !srcB || srcA === 'Unknown' || srcB === 'Unknown') return 0;
  if (srcA === srcB) return 1;
  const famA = SOURCE_FAMILY[srcA];
  return famA !== undefined && famA === SOURCE_FAMILY[srcB] ? 0.5 : 0;
}

// Format (#8): exact match = 1; "sibling" formats = 0.5. TV and ONA are
// both episodic series (ONA is just the streaming-native label); OVA and
// SPECIAL are both side-content. MOVIE stands alone.
const FORMAT_SIBLINGS = { TV: 'ONA', ONA: 'TV', OVA: 'SPECIAL', SPECIAL: 'OVA' };

function formatScore(fmtA, fmtB) {
  if (!fmtA || !fmtB) return 0;
  if (fmtA === fmtB) return 1;
  return FORMAT_SIBLINGS[fmtA] === fmtB ? 0.5 : 0;
}

// Batch-fetch the categorical fields for the query anime + all candidates,
// then score each candidate against the query. Returns Map<id, {era,
// episodes, format}> with every score already in [0, 1] — no min-max
// needed at merge time (unlike generator scores, these are absolute).
function categoricalScores(animeId, candidateIds) {
  const out = new Map();
  if (candidateIds.length === 0) return out;

  const q = db.prepare(
    'SELECT season_year, episodes, format, source FROM anime WHERE id = ?'
  ).get(animeId);
  if (!q) return out;

  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, season_year, episodes, format, source
    FROM anime WHERE id IN (${placeholders})
  `).all(...candidateIds);

  for (const r of rows) {
    out.set(r.id, {
      era:      eraScore(q.season_year, r.season_year),
      episodes: episodesScore(q.episodes, r.episodes),
      source:   sourceScore(q.source, r.source),
      format:   formatScore(q.format, r.format),
    });
  }
  return out;
}

// =============================================================================
// Signal #12 — relations graph (a FILTER, not a similarity signal)
// =============================================================================

// "More like this" must mean OTHER anime. Mushishi's nearest neighbors are
// its own sequels and specials — true, and useless to show. This signal
// walks the `relations` table from the query anime and the resulting id
// set is EXCLUDED from the candidate pool (the anime page already lists
// the franchise in its own relations section, where it belongs).
//
// Why the walk is depth-limited to 3, not the full transitive closure:
// our v1 relations are uncategorized (`relation_type = 'RELATED'`, see the
// signal-table revisions in CLAUDE.md), so crossover specials chain
// unrelated franchises together — the full closure from Fate/Dragon
// Ball/Lupin reaches ONE shared component of ~3,485 anime (~9% of the
// catalog), measured 2026-06-12. Depth 3 is the smallest depth that still
// covers a real franchise's stragglers (Mushishi needs 3 hops to reach
// Zoku Shou: Suzu no Shizuku) while keeping the worst measured blast
// radius at ~244 (Dragon Ball Z). The cost is over-exclusion of crossover
// partners (DBZ's walk swallows One Piece) — invisible against a
// 100-candidate pool, unlike franchise spam which is a visible bug.
// When v2 brings categorized relation types, stop traversing
// crossover/character edges instead of capping depth.
const FRANCHISE_DEPTH = 3;

const FRANCHISE_WALK_SQL = `
  WITH RECURSIVE walk(id, d) AS (
    SELECT ?, 0
    UNION
    SELECT r.related_anime_id, w.d + 1
    FROM relations r JOIN walk w ON r.anime_id = w.id
    WHERE w.d < ?
    UNION
    SELECT r.anime_id, w.d + 1
    FROM relations r JOIN walk w ON r.related_anime_id = w.id
    WHERE w.d < ?
  )
  SELECT DISTINCT id FROM walk
`;

// Returns the Set of anime ids within `depth` relation-hops of animeId,
// including animeId itself. Reads only the `relations` table; an anime
// with no relations returns just itself.
function franchiseIds(animeId, depth = FRANCHISE_DEPTH) {
  const rows = db.prepare(FRANCHISE_WALK_SQL).all(animeId, depth, depth);
  return new Set(rows.map((r) => r.id));
}

// True when one title equals the other, or is a word-boundary prefix of
// the other ("death note" → "death note rewrite 1: visions of a god").
// Both inputs must already be lowercased.
function titlesAreKin(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  if (!b.startsWith(a)) return false;
  return b.length === a.length || !/[a-z0-9]/.test(b[a.length]);
}

// Builds the signal-#12 exclusion predicate for one query anime: a
// function (candidateRow) => true when the candidate must be dropped from
// the rec pool. Called once per recommendFromAnime when excludeFranchise
// is on. Candidate rows must carry id, title_romaji, title_english
// (every generator SELECTs all three).
//
// The relation walk alone is NOT enough: 22.4K of 38.5K catalog rows have
// no relations at all, because the offline-DB carries some entries
// multiple times (once per source site) and the copy without cross-ids
// gets no relatedAnime. Measured leaks: a second FMA: Brotherhood row
// (OVA, no mal_id, zero relations) topped its own twin's rec list, and
// "Death Note Rewrite 1/2" (split-episode twins of the linked Death Note:
// Rewrite) surfaced on Death Note's page. So a candidate is ALSO dropped
// when either of its titles is kin (exact or word-boundary prefix, either
// direction) to any walk member's title. Deliberate over-exclusion:
// "Monster" swallows "Monster Musume" too — invisible against a
// 100-candidate pool, unlike franchise spam, which is a visible bug.
function franchiseExcluder(animeId, depth = FRANCHISE_DEPTH) {
  const ids = franchiseIds(animeId, depth);

  const memberPh = [...ids].map(() => '?').join(',');
  const names = [];
  for (const t of db.prepare(
    `SELECT title_romaji, title_english FROM anime WHERE id IN (${memberPh})`
  ).all(...ids)) {
    if (t.title_romaji)  names.push(t.title_romaji.toLowerCase());
    if (t.title_english) names.push(t.title_english.toLowerCase());
  }

  return (row) => {
    if (ids.has(row.id)) return true;
    for (const cand of [row.title_romaji, row.title_english]) {
      if (!cand) continue;
      const lc = cand.toLowerCase();
      if (names.some((n) => titlesAreKin(n, lc))) return true;
    }
    return false;
  };
}

// =============================================================================
// Multi-signal merge — combine per-signal candidate lists into one ranking
// =============================================================================

// Min-max normalize an array's `scoreKey` field into [0, 1] in place.
// Used when merging signals so a synopsis-similarity 0.6 and a tag-score
// 42.3 are comparable. Constant-input arrays normalize to 0.
function minMaxNormalize(rows, scoreKey) {
  if (rows.length === 0) return rows;
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) {
    if (r[scoreKey] < lo) lo = r[scoreKey];
    if (r[scoreKey] > hi) hi = r[scoreKey];
  }
  const range = hi - lo;
  for (const r of rows) {
    r[scoreKey] = range === 0 ? 0 : (r[scoreKey] - lo) / range;
  }
  return rows;
}

// Merges per-signal candidate lists into one ranked list.
//   inputs:   { synopsis: [...rows], tags: [...rows], ... }  (signal name → rows)
//   weights:  { synopsis: 0.35, tags: 0.25, ... }
// An anime that surfaces in only one signal gets that signal's weighted score
// and 0 for the missing ones. This naturally biases toward "appears in
// multiple signals" — the candidates we're most confident about.
//
// opts.refineFor: query anime id. When set, the era/episodes/format
// refiners (#5/#6/#8) score every pooled candidate against the query
// anime and their weighted scores adjust the ranking BEFORE the final
// sort + slice. Refiners adjust scores but don't appear in the `signals`
// provenance string — that string answers "which signal FOUND this."
// opts.refiners: subset of ['era', 'episodes', 'source', 'format'] to
// apply (defaults to all four).
// opts.exclude: predicate (candidateRow) => bool; rows answering true are
// dropped from every candidate list (signal #12's franchise filter).
// Applied BEFORE min-max normalization — a same-franchise near-perfect
// match would otherwise set the per-signal ceiling and compress every
// real candidate's normalized score.
function mergeSignals(inputs, weights, opts = {}) {
  const {
    limit = 10,
    refineFor = null,
    refiners = ['era', 'episodes', 'source', 'format'],
    exclude = null,
  } = opts;

  if (exclude) {
    const filtered = {};
    for (const sig of Object.keys(inputs)) {
      filtered[sig] = inputs[sig].filter((r) => !exclude(r));
    }
    inputs = filtered;
  }

  const normalized = {};
  if (inputs.synopsis) {
    const withSim = inputs.synopsis.map((r) => ({ ...r, _score: 1 - r.dist }));
    normalized.synopsis = minMaxNormalize(withSim, '_score');
  }
  if (inputs.tags) {
    const withScore = inputs.tags.map((r) => ({ ...r, _score: r.tag_score }));
    normalized.tags = minMaxNormalize(withScore, '_score');
  }
  if (inputs.genre) {
    const withScore = inputs.genre.map((r) => ({ ...r, _score: r.genre_score }));
    normalized.genre = minMaxNormalize(withScore, '_score');
  }
  // Studio is NOT min-max normalized — its score is already an absolute
  // fraction of the query's studio identity in (0, 1]. Min-max would
  // collapse the (very common) all-one-studio pool to zero. See the
  // neighborsByStudio comment.
  if (inputs.studio) {
    normalized.studio = inputs.studio.map((r) => ({ ...r, _score: r.studio_score }));
  }

  const merged = new Map();
  for (const sig of Object.keys(normalized)) {
    const w = weights[sig] || 0;
    for (const r of normalized[sig]) {
      const existing = merged.get(r.id);
      if (existing) {
        existing.score += w * r._score;
        existing.signals.push(sig);
      } else {
        merged.set(r.id, {
          id: r.id,
          title: r.title_english || r.title_romaji,
          average_score: r.average_score,
          score: w * r._score,
          signals: [sig],
        });
      }
    }
  }

  // Refinement pass — categorical scores are absolute [0, 1], so they
  // add straight into the weighted sum without min-max normalization.
  if (refineFor !== null && refiners.length > 0 && merged.size > 0) {
    const cat = categoricalScores(refineFor, [...merged.keys()]);
    for (const r of merged.values()) {
      const c = cat.get(r.id);
      if (!c) continue;
      if (refiners.includes('era'))      r.score += (weights.era      || 0) * c.era;
      if (refiners.includes('episodes')) r.score += (weights.episodes || 0) * c.episodes;
      if (refiners.includes('source'))   r.score += (weights.source   || 0) * c.source;
      if (refiners.includes('format'))   r.score += (weights.format   || 0) * c.format;
    }
  }

  // Final ranking, deduped by display title: the catalog carries some
  // entries twice (offline-DB source twins, e.g. two Baccano! rows) and
  // both can reach the pool — a list showing the same title twice reads
  // as broken. Keep the higher-scored twin.
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const seenTitles = new Set();
  const out = [];
  for (const r of ranked) {
    if (out.length === limit) break;
    const key = (r.title || '').toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    out.push({
      id: r.id,
      title: r.title,
      score: Number(r.score.toFixed(4)),
      signals: r.signals.join('+'),
      average_score: r.average_score,
    });
  }
  return out;
}

// =============================================================================
// Top-level recommendation entry points
// =============================================================================

// "More like this anime." Fans out to each enabled generator signal,
// normalizes, weighted-sums, applies the categorical refiners, returns
// top N. `signals` and `weights` are overridable so the UI can later
// expose per-axis sliders.
//
// excludeFranchise (default ON) drops the query anime's whole franchise
// from the results via signal #12 — nobody needs to hear that Mushishi
// is similar to Mushishi. Pass false to get the raw "nearest of anything"
// ranking (useful for debugging signal quality).
function recommendFromAnime(animeId, opts = {}) {
  const {
    limit = 10,
    poolSize = 100,
    signals = ['synopsis', 'tags', 'genre', 'studio', 'era', 'episodes', 'source', 'format'],
    weights = DEFAULT_WEIGHTS,
    excludeFranchise = true,
  } = opts;

  const inputs = {};
  if (signals.includes('synopsis')) inputs.synopsis = neighborsBySynopsis(animeId, poolSize);
  if (signals.includes('tags'))     inputs.tags     = neighborsByTags(animeId, poolSize);
  if (signals.includes('genre'))    inputs.genre    = neighborsByGenres(animeId, poolSize);
  if (signals.includes('studio'))   inputs.studio   = neighborsByStudio(animeId, poolSize);

  const refiners = ['era', 'episodes', 'source', 'format'].filter((s) => signals.includes(s));
  const exclude = excludeFranchise ? franchiseExcluder(animeId) : null;
  return mergeSignals(inputs, weights, { limit, refineFor: animeId, refiners, exclude });
}

// "For you." Personalized recommendations from the user's taste vector —
// the weighted-sum-of-watched-synopsis-vectors that src/library.js keeps in
// user_vectors.synopsis_taste_vec, refreshed after every list change. This
// is the consumer that vector was built for (onboarding produces it; the
// Library page renders these).
//
// v1 ranks on the SYNOPSIS facet alone, because that's the only facet
// recomputeTasteVector populates today — tag/character/review taste vectors
// are v2 and stay NULL. When they land, blend them in here; nothing is faked
// in the meantime.
//
// Returns [] when there's no usable taste direction yet (empty list, or
// positives and negatives that cancelled to ~zero — recomputeTasteVector
// stores NULL in that case). The caller treats [] as "do the onboarding /
// add some shows first," not an error.
//
// Each rec carries:
//   score          — cosine similarity to the taste vector, in [-1, 1]
//   signals: 'taste'
//   because        — { id, title, similarity } of the positively-weighted
//                    anime on the user's list this rec is closest to, i.e.
//                    the "because you loved X" explanation (null if the
//                    vector is driven purely by negative signals)
function recommendFromUser(userId, opts = {}) {
  const {
    limit = 20,
    poolSize = 200,
    excludeFranchise = true,
  } = opts;

  const tv = db
    .prepare('SELECT synopsis_taste_vec FROM user_vectors WHERE user_id = ?')
    .get(userId);
  const taste = tv && tv.synopsis_taste_vec ? tv.synopsis_taste_vec : null;
  if (!taste) return [];

  // Never recommend something already on the list, in ANY status — a rec for
  // a show they're already tracking (even one they only planned) is noise.
  const listed = db
    .prepare('SELECT anime_id FROM user_anime WHERE user_id = ?')
    .all(userId)
    .map((r) => r.anime_id);
  const listedPh = listed.map(() => '?').join(',');

  // Nearest catalog anime to the taste vector. The bound BLOB is read by
  // sqlite-vec as a 384-d float32 vector, same as the column it's compared
  // against. Sorted most-similar-first; we over-fetch (poolSize > limit) so
  // the franchise filter and title-dedupe below have room to drop rows.
  const pool = db
    .prepare(
      `SELECT a.id, a.title_romaji, a.title_english, a.average_score,
              vec_distance_cosine(a.synopsis_vec, ?) AS dist
         FROM anime a
        WHERE a.synopsis_vec IS NOT NULL
          AND a.is_adult = 0
          ${listed.length ? `AND a.id NOT IN (${listedPh})` : ''}
        ORDER BY dist ASC
        LIMIT ?`
    )
    .all(taste, ...listed, poolSize);

  // The anime that positively shaped the taste vector — the seeds for both
  // the franchise filter (don't recommend a sequel of a show they love) and
  // the "because you loved X" explanation. tasteWeight is the same scoring
  // recomputeTasteVector used; we lazy-require it because library.js requires
  // THIS module at load time, and a top-level back-require would hand us a
  // half-initialized library module.
  const { tasteWeight } = require('./library');
  const seeds = db
    .prepare(
      `SELECT ua.anime_id AS id, ua.status, ua.score, ua.is_favorite,
              ua.rewatched_count, a.title_romaji, a.title_english, a.synopsis_vec
         FROM user_anime ua
         JOIN anime a ON a.id = ua.anime_id
        WHERE ua.user_id = ? AND a.synopsis_vec IS NOT NULL`
    )
    .all(userId)
    .filter((s) => tasteWeight(s) > 0);

  // One franchise excluder per positive seed; a candidate is dropped if it
  // belongs to ANY of their franchises. Cost is one depth-3 relation walk
  // per seed — trivial for an onboarding pick-5, fine for normal lists; if
  // libraries ever grow into the thousands this is the line to revisit.
  const excluders = excludeFranchise ? seeds.map((s) => franchiseExcluder(s.id)) : [];

  // Single pass: apply the franchise filter, dedupe by display title (the
  // catalog carries some entries twice — see mergeSignals), take `limit`.
  const seenTitles = new Set();
  const finalRows = [];
  for (const row of pool) {
    if (finalRows.length === limit) break;
    if (excluders.some((ex) => ex(row))) continue;
    const key = (row.title_english || row.title_romaji || '').toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    finalRows.push(row);
  }

  // Explainability: anchor each rec to the positive seed it's most similar
  // to. We need the candidates' own vectors for this (the pool query only
  // returned distance-to-taste), so fetch them for the final slice only.
  const seedVecs = seeds.map((s) => ({
    id: s.id,
    title: s.title_english || s.title_romaji,
    vec: bufferToFloat32(s.synopsis_vec),
  }));
  const candVecs = new Map();
  if (seedVecs.length && finalRows.length) {
    const ids = finalRows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    for (const r of db
      .prepare(`SELECT id, synopsis_vec FROM anime WHERE id IN (${ph})`)
      .all(...ids)) {
      candVecs.set(r.id, bufferToFloat32(r.synopsis_vec));
    }
  }

  return finalRows.map((row) => {
    let because = null;
    const cv = candVecs.get(row.id);
    if (cv) {
      let bestSim = -Infinity;
      for (const sv of seedVecs) {
        const sim = cosineSimilarity(cv, sv.vec);
        if (sim > bestSim) {
          bestSim = sim;
          because = { id: sv.id, title: sv.title, similarity: Number(sim.toFixed(4)) };
        }
      }
    }
    return {
      id: row.id,
      title: row.title_english || row.title_romaji,
      score: Number((1 - row.dist).toFixed(4)),
      signals: 'taste',
      average_score: row.average_score,
      because,
    };
  });
}

module.exports = {
  // public API
  recommendFromAnime,
  recommendFromUser,
  // per-signal candidate fetchers (exposed for tests + future re-use)
  neighborsBySynopsis,
  neighborsByTags,
  neighborsByGenres,
  neighborsByStudio,
  categoricalScores,
  franchiseIds,
  franchiseExcluder,
  titlesAreKin,
  // merge plumbing (exposed for tests + future "explain" UI)
  mergeSignals,
  minMaxNormalize,
  // math layer
  cosineSimilarity,
  l2Normalize,
  averageVectors,
  bufferToFloat32,
  float32ToBuffer,
  // config
  DEFAULT_WEIGHTS,
  TAG_ALIASES,
};

// ---------- smoke test ----------
// Run with: node src/recommender.js
// Phase 1: pure math sanity checks (no DB needed, always runs).
// Phase 2: end-to-end "more like this" against the live DB (skipped if
//          fewer than 10 anime have synopsis_vec yet).
if (require.main === module) {
  function assert(cond, msg) {
    if (!cond) {
      console.error('  FAIL:', msg);
      process.exit(1);
    } else {
      console.log('  ok:  ', msg);
    }
  }

  console.log('Phase 1 — pure vector math');

  // cos(u, u) = 1
  const u = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) u[i] = Math.sin(i / 7);
  l2Normalize(u);
  assert(Math.abs(cosineSimilarity(u, u) - 1) < 1e-5, 'cos(u, u) = 1');

  // cos(e0, e1) = 0  (orthogonal basis vectors)
  const e0 = new Float32Array(EMBED_DIM); e0[0] = 1;
  const e1 = new Float32Array(EMBED_DIM); e1[1] = 1;
  assert(Math.abs(cosineSimilarity(e0, e1)) < 1e-9, 'cos(e0, e1) = 0');

  // cos(u, -u) = -1
  const minusU = new Float32Array(u.length);
  for (let i = 0; i < u.length; i++) minusU[i] = -u[i];
  assert(Math.abs(cosineSimilarity(u, minusU) + 1) < 1e-5, 'cos(u, -u) = -1');

  // l2Normalize produces unit length
  const w = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) w[i] = i + 1;
  l2Normalize(w);
  let sumSq = 0;
  for (const x of w) sumSq += x * x;
  assert(Math.abs(Math.sqrt(sumSq) - 1) < 1e-5, 'l2Normalize -> unit length');

  // averageVectors([u, u, u]) === u (still unit)
  const avg = averageVectors([u, u, u]);
  assert(Math.abs(cosineSimilarity(avg, u) - 1) < 1e-5, 'avg(u, u, u) = u');

  // Buffer round-trip is lossless
  const f = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) f[i] = (i % 13) * 0.1;
  const buf = float32ToBuffer(f);
  const back = bufferToFloat32(buf);
  let maxDiff = 0;
  for (let i = 0; i < f.length; i++) maxDiff = Math.max(maxDiff, Math.abs(f[i] - back[i]));
  assert(maxDiff < 1e-9, 'Float32 <-> Buffer round-trip is lossless');

  // Categorical refiner scoring (#5/#6/#8)
  assert(eraScore(2000, 2000) === 1, 'era: same year = 1');
  assert(Math.abs(eraScore(1998, 2003) - 0.75) < 1e-9, 'era: 5 years apart = 0.75');
  assert(eraScore(1998, 2024) === 0, 'era: 26 years apart = 0');
  assert(eraScore(null, 2020) === 0, 'era: missing year = 0');
  assert(episodesScore(12, 13) === 1, 'episodes: 12 vs 13 same bucket = 1');
  assert(episodesScore(12, 24) === 0.5, 'episodes: one vs two cour adjacent = 0.5');
  assert(episodesScore(12, 500) === 0, 'episodes: cour vs epic = 0');
  assert(formatScore('TV', 'TV') === 1, 'format: TV vs TV = 1');
  assert(formatScore('TV', 'ONA') === 0.5, 'format: TV vs ONA siblings = 0.5');
  assert(formatScore('TV', 'MOVIE') === 0, 'format: TV vs MOVIE = 0');
  assert(sourceScore('Manga', 'Manga') === 1, 'source: Manga vs Manga = 1');
  assert(sourceScore('Manga', 'Web manga') === 0.5, 'source: Manga vs Web manga family = 0.5');
  assert(sourceScore('Light novel', 'Visual novel') === 0, 'source: light novel vs visual novel = 0');
  assert(sourceScore('Original', 'Original') === 1, 'source: Original vs Original = 1');
  assert(sourceScore('Unknown', 'Unknown') === 0, 'source: Unknown carries no information');
  assert(sourceScore(null, 'Manga') === 0, 'source: missing = 0');

  // Signal #12 title kinship (franchise twins the relations graph misses)
  assert(titlesAreKin('death note', 'death note'), 'kin: exact match');
  assert(titlesAreKin('death note', 'death note rewrite 1: visions of a god'),
    'kin: word-boundary prefix');
  assert(titlesAreKin('death note rewrite 1: visions of a god', 'death note'),
    'kin: prefix check is symmetric');
  assert(!titlesAreKin('mushishi', 'mushi-uta'), 'kin: mushishi vs mushi-uta differ');
  assert(!titlesAreKin('death note', 'death notebook of doom'),
    'kin: prefix without word boundary does not match');

  console.log('\nPhase 2 — end-to-end against the live DB');

  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM anime WHERE synopsis_vec IS NOT NULL'
  ).get().n;
  const tagCount = db.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
  const aliasCount = Object.keys(TAG_ALIASES).length;
  console.log(`  anime with synopsis_vec: ${count.toLocaleString()}`);
  console.log(`  unique tags in catalog: ${tagCount.toLocaleString()}`);
  console.log(`  tag aliases loaded: ${aliasCount}`);
  if (count < 10) {
    console.log('  fewer than 10 vectors present — skipping end-to-end test');
    console.log('\nMath layer passed.');
    process.exit(0);
  }

  // Helper — render one anchor anime under three views so the user can
  // see how each signal scores it and how the merge changes the ranking.
  function renderAnchor(refLabel, animeRow) {
    const title = animeRow.title_english || animeRow.title_romaji;
    console.log(`\n  === ${refLabel}: ${title} (anime.id=${animeRow.id}) ===`);

    // (a) synopsis only — wire just signal #1
    const syn = recommendFromAnime(animeRow.id, { limit: 5, signals: ['synopsis'] });
    console.log('  synopsis-only top 5:');
    for (const r of syn) console.log(`    ${r.score.toFixed(4)}  ${r.title}`);

    // (b) tags only — wire just signal #2
    const tags = recommendFromAnime(animeRow.id, { limit: 5, signals: ['tags'] });
    console.log('  tags-only top 5:');
    if (tags.length === 0) console.log('    (no tags on this anime)');
    for (const r of tags) console.log(`    ${r.score.toFixed(4)}  ${r.title}`);

    // (c) genre only — wire just signal #3
    const genre = recommendFromAnime(animeRow.id, { limit: 5, signals: ['genre'] });
    console.log('  genre-only top 5:');
    if (genre.length === 0) console.log('    (no genres on this anime — run scripts/seed-genres-from-tags.js)');
    for (const r of genre) console.log(`    ${r.score.toFixed(4)}  ${r.title}`);

    // (d) studio only — wire just signal #4
    const studio = recommendFromAnime(animeRow.id, { limit: 5, signals: ['studio'] });
    console.log('  studio-only top 5:');
    if (studio.length === 0) console.log('    (no animation studio on record for this anime)');
    for (const r of studio) console.log(`    ${r.score.toFixed(4)}  ${r.title}`);

    // (e) merged — all generators + era/episodes/format refiners
    const merged = recommendFromAnime(animeRow.id, { limit: 5 });
    console.log('  merged (all signals) top 5:');
    for (const r of merged) {
      console.log(`    ${r.score.toFixed(4)}  [${r.signals.padEnd(26)}]  ${r.title}`);
    }
  }

  // Well-known anchors. Skip any not yet processed.
  const reference = [
    { mal_id:    1, label: 'Cowboy Bebop' },
    { mal_id:   20, label: 'Naruto' },
    { mal_id:  226, label: 'Elfen Lied' },
    { mal_id: 1535, label: 'Death Note' },
    { mal_id: 5114, label: 'Fullmetal Alchemist: Brotherhood' },
  ];

  let printed = 0;
  for (const ref of reference) {
    const row = db.prepare(
      'SELECT id, title_romaji, title_english FROM anime WHERE mal_id = ? AND synopsis_vec IS NOT NULL'
    ).get(ref.mal_id);
    if (!row) {
      console.log(`\n  ${ref.label} (mal ${ref.mal_id}): not yet processed — skip`);
      continue;
    }
    renderAnchor(ref.label, row);
    printed++;
  }

  // Signal #12 — the franchise filter. Mushishi is the motivating case
  // (its top recs were its own sequels and specials); Death Note covers
  // the relations-less title-twin leak ("Death Note Rewrite 1/2").
  const sigTwelveCases = [
    { mal_id:  457, kinTitle: 'mushishi' },
    { mal_id: 1535, kinTitle: 'death note' },
  ];
  for (const c of sigTwelveCases) {
    const row = db.prepare(
      'SELECT id, title_romaji FROM anime WHERE mal_id = ? AND synopsis_vec IS NOT NULL'
    ).get(c.mal_id);
    if (!row) {
      console.log(`\n  mal ${c.mal_id} not processed — skipping signal #12 check`);
      continue;
    }
    console.log(`\n  === Signal #12 — franchise filter (${row.title_romaji}, mal ${c.mal_id}) ===`);
    const fam = franchiseIds(row.id);
    assert(fam.has(row.id), 'franchise walk includes the query anime itself');
    assert(fam.size >= 4, `franchise walk reaches the sequels/specials (got ${fam.size})`);
    const recs = recommendFromAnime(row.id, { limit: 10 });
    assert(recs.every((r) => !fam.has(r.id)), 'no walk members in the filtered recs');
    assert(recs.every((r) => !titlesAreKin(c.kinTitle, r.title.toLowerCase())),
      `no title-twins of "${c.kinTitle}" in the filtered recs`);
    const raw = recommendFromAnime(row.id, { limit: 10, excludeFranchise: false });
    assert(raw.some((r) => fam.has(r.id) || titlesAreKin(c.kinTitle, r.title.toLowerCase())),
      'excludeFranchise:false still surfaces the franchise (filter is the only thing hiding it)');
    console.log('  filtered top 10:');
    for (const r of recs) console.log(`    ${r.score.toFixed(4)}  [${r.signals.padEnd(26)}]  ${r.title}`);
  }

  // Personalized "for you" — runs only against a real user who already has a
  // taste vector, so the smoke test never has to mutate user data. If no such
  // user exists yet (fresh DB, nobody's built a list), it's skipped.
  console.log('\nPhase 3 — personalized recommendFromUser');
  const tasteUser = db
    .prepare(
      `SELECT user_id FROM user_vectors
        WHERE synopsis_taste_vec IS NOT NULL LIMIT 1`
    )
    .get();
  if (!tasteUser) {
    console.log('  no user has a taste vector yet — skipping (build a list first)');
  } else {
    const uid = tasteUser.user_id;
    const listed = new Set(
      db.prepare('SELECT anime_id FROM user_anime WHERE user_id = ?').all(uid).map((r) => r.anime_id)
    );
    const recs = recommendFromUser(uid, { limit: 10 });
    console.log(`  === user ${uid} — ${recs.length} recs ===`);
    assert(recs.length > 0, 'taste vector present ⇒ at least one rec');
    assert(recs.every((r) => !listed.has(r.id)), 'no already-listed anime in the recs');
    assert(recs.every((r) => r.signals === 'taste'), "every rec is provenance 'taste'");
    assert(recs.every((r) => r.score >= -1 && r.score <= 1), 'taste similarity in [-1, 1]');
    const titles = recs.map((r) => r.title.toLowerCase());
    assert(new Set(titles).size === titles.length, 'no duplicate titles in the recs');
    for (const r of recs) {
      const why = r.because ? `  ← ${r.because.title} (${r.because.similarity})` : '';
      console.log(`    ${r.score.toFixed(4)}  ${r.title}${why}`);
    }
  }

  if (printed === 0) {
    console.log('\nNone of the anchor titles have been processed yet — try again later.');
  } else {
    console.log(`\nEnd-to-end test complete — ${printed} anchor(s) rendered.`);
  }
}

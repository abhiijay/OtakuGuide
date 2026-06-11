// src/recommender.js
// Generates anime recommendations from a multi-signal weighted-sum
// similarity model. v1 starts with signal #1 (synopsis embedding) wired
// end-to-end and grows one signal per commit.
//
// Top-level exports:
//   recommendFromAnime(animeId, opts) — "more like this anime"
//   recommendForUser(userId, opts)    — personalized; needs user_anime data (v2)
//
// Roadmap (each commit adds one signal, smoke-tested against real data):
//   #1 synopsis embedding via sqlite-vec       [LIVE]
//   #2 tag TF-IDF (with db/tag-aliases.json)   [next]
//   #3 genre one-hot overlap
//   #4 studio match
//   #5-#8 era / episode-count / source / format categoricals
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
function mergeSignals(inputs, weights, opts = {}) {
  const { limit = 10 } = opts;

  const normalized = {};
  if (inputs.synopsis) {
    const withSim = inputs.synopsis.map((r) => ({ ...r, _score: 1 - r.dist }));
    normalized.synopsis = minMaxNormalize(withSim, '_score');
  }
  if (inputs.tags) {
    const withScore = inputs.tags.map((r) => ({ ...r, _score: r.tag_score }));
    normalized.tags = minMaxNormalize(withScore, '_score');
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

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      title: r.title,
      score: Number(r.score.toFixed(4)),
      signals: r.signals.join('+'),
      average_score: r.average_score,
    }));
}

// =============================================================================
// Top-level recommendation entry points
// =============================================================================

// "More like this anime." Fans out to each enabled signal, normalizes,
// weighted-sums, returns top N. Defaults to synopsis + tags (the two
// signals wired so far). `signals` and `weights` are overridable so the
// UI can later expose per-axis sliders.
function recommendFromAnime(animeId, opts = {}) {
  const {
    limit = 10,
    poolSize = 100,
    signals = ['synopsis', 'tags'],
    weights = DEFAULT_WEIGHTS,
  } = opts;

  const inputs = {};
  if (signals.includes('synopsis')) inputs.synopsis = neighborsBySynopsis(animeId, poolSize);
  if (signals.includes('tags'))     inputs.tags     = neighborsByTags(animeId, poolSize);

  return mergeSignals(inputs, weights, { limit });
}

module.exports = {
  // public API
  recommendFromAnime,
  // per-signal candidate fetchers (exposed for tests + future re-use)
  neighborsBySynopsis,
  neighborsByTags,
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

    // (c) merged — synopsis + tags weighted
    const merged = recommendFromAnime(animeRow.id, { limit: 5 });
    console.log('  merged (synopsis + tags) top 5:');
    for (const r of merged) {
      console.log(`    ${r.score.toFixed(4)}  [${r.signals.padEnd(13)}]  ${r.title}`);
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

  if (printed === 0) {
    console.log('\nNone of the anchor titles have been processed yet — try again later.');
  } else {
    console.log(`\nEnd-to-end test complete — ${printed} anchor(s) rendered.`);
  }
}

// scripts/import-anime.js
// Orchestrator that fills the catalog. Run with:
//
//   npm run import          (full run, ~6 hr)
//   npm run import -- --limit=100   (smoke run, first 100 in Phase B)
//   npm run import -- --reset       (ignore checkpoint, start over)
//   npm run import -- --skip-a      (skip Phase A; assumes already done)
//
// Three phases, in order:
//
//   Phase A — bulk catalog skeleton from anime-offline-database.
//     Idempotent (INSERT OR IGNORE on lookups; anime rows skipped if
//     identifying ID already present). ~30 seconds for ~41K rows.
//
//   Phase B — per-anime synopsis enrichment.
//     For each anime: fetch Jikan + Wikipedia in parallel, embed each
//     synopsis separately, average the vectors, store
//     synopsis_mal + synopsis_wiki + synopsis_vec on the row.
//     Insert themes + demographics from Jikan as tags. Throttled by
//     each source's per-module rate limiter. ~6 hours for the full run.
//     Resumable via db/import-progress.json checkpoint.
//
//   Phase C — relations second pass.
//     Resolves `relatedAnime` URLs back to local anime ids and inserts
//     into the relations table with relation_type='RELATED'. Skips
//     URLs whose target isn't in our catalog. ~1 minute.

'use strict';

const fs = require('fs');
const path = require('path');

const { db } = require('../src/db');
const { loadOfflineDb } = require('../src/offline-db');
const { fetchAnime: fetchJikan } = require('../src/jikan');
const { fetchPlotSection } = require('../src/wiki');
const { embed, EMBED_DIM, EMBED_BYTES } = require('../src/embeddings');

const CHECKPOINT_PATH = path.join(__dirname, '..', 'db', 'import-progress.json');

// ---------- CLI arg parsing ----------
function parseArgs(argv) {
  const out = { limit: null, reset: false, skipA: false };
  for (const a of argv.slice(2)) {
    if (a === '--reset') out.reset = true;
    else if (a === '--skip-a') out.skipA = true;
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice('--limit='.length), 10);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// ---------- checkpoint ----------
function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
  } catch (err) {
    console.warn(`Checkpoint corrupt (${err.message}); starting fresh.`);
    return null;
  }
}

function saveCheckpoint(state) {
  // Atomic: write to .tmp then rename so a crash can't leave a half-file.
  const tmp = CHECKPOINT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CHECKPOINT_PATH);
}

// ---------- shared helpers ----------
const now = () => new Date().toISOString();

// Light tag cleanup. Catalog frequency-based TF-IDF later does the
// heavy lifting; this just collapses pure-case duplicates and drops
// useless one/two-character tokens like "tv".
function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length < 3) return null;
  return t;
}

// Average N L2-normalized 384-d Float32 vectors into one 1536-byte Buffer.
// Re-normalizes the sum so cosine math stays clean. Returns null if no inputs.
function averageVectors(buffers) {
  if (buffers.length === 0) return null;
  if (buffers.length === 1) return buffers[0];

  const sum = new Float32Array(EMBED_DIM);
  for (const buf of buffers) {
    const view = new Float32Array(buf.buffer, buf.byteOffset, EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) sum[i] += view[i];
  }

  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBED_DIM; i++) sum[i] /= norm;
  }

  const out = Buffer.alloc(EMBED_BYTES);
  new Float32Array(out.buffer, out.byteOffset, EMBED_DIM).set(sum);
  return out;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

// ---------- Phase A: catalog skeleton ----------
function runPhaseA(records) {
  console.log(`\nPhase A — inserting ${records.length.toLocaleString()} catalog rows...`);
  const t0 = Date.now();

  // Skip if already populated. Importer is idempotent if you re-run
  // but Phase A is uninteresting work after that — short-circuit.
  const existing = db.prepare('SELECT COUNT(*) AS n FROM anime').get().n;
  if (existing > 0) {
    console.log(`  ${existing} anime rows already present — skipping Phase A.`);
    return;
  }

  const insertAnime = db.prepare(`
    INSERT INTO anime (
      anilist_id, mal_id, title_romaji, synonyms,
      cover_image_url,
      format, episodes, duration_minutes, season, season_year, status,
      average_score, is_adult,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const selectTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const joinTag = db.prepare(
    'INSERT OR IGNORE INTO anime_tags (anime_id, tag_id) VALUES (?, ?)',
  );
  const insertStudio = db.prepare(
    'INSERT OR IGNORE INTO studios (name) VALUES (?)',
  );
  const selectStudio = db.prepare('SELECT id FROM studios WHERE name = ?');
  const joinStudio = db.prepare(
    'INSERT OR IGNORE INTO anime_studios (anime_id, studio_id, is_main) VALUES (?, ?, ?)',
  );

  const nowStr = now();
  let inserted = 0;
  let skippedNoTitle = 0;

  db.exec('BEGIN');
  try {
    for (const rec of records) {
      if (!rec.title) {
        skippedNoTitle++;
        continue;
      }
      const result = insertAnime.run(
        rec.anilist_id,
        rec.mal_id,
        rec.title,
        rec.synonyms?.length ? JSON.stringify(rec.synonyms) : null,
        rec.cover_image_url,
        rec.format,
        rec.episodes,
        rec.duration_minutes,
        rec.season,
        rec.season_year,
        rec.status,
        rec.average_score,
        nowStr,
      );
      const animeId = result.lastInsertRowid;
      inserted++;

      // Tags. Offline-DB mixes genre + tag + theme labels; we put them all
      // in `tags` (signal #2 uses TF-IDF over the full pool).
      for (const tag of rec.tags || []) {
        const n = normalizeTag(tag);
        if (!n) continue;
        insertTag.run(n);
        joinTag.run(animeId, selectTag.get(n).id);
      }

      // Studios. Offline-DB doesn't flag main vs licensor; treat all as main
      // (signal #4 stays sane because most anime have only 1-2 studios listed).
      for (const studio of rec.studios || []) {
        if (!studio) continue;
        insertStudio.run(studio);
        joinStudio.run(animeId, selectStudio.get(studio).id, 1);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const counts = {
    anime: inserted,
    tags: db.prepare('SELECT COUNT(*) AS n FROM tags').get().n,
    studios: db.prepare('SELECT COUNT(*) AS n FROM studios').get().n,
    animeTags: db.prepare('SELECT COUNT(*) AS n FROM anime_tags').get().n,
    animeStudios: db.prepare('SELECT COUNT(*) AS n FROM anime_studios').get().n,
  };
  console.log(`  inserted: ${inserted.toLocaleString()} anime in ${fmtDuration(Date.now() - t0)}`);
  console.log(`  lookups:  ${counts.tags.toLocaleString()} tags, ${counts.studios.toLocaleString()} studios`);
  console.log(`  joins:    ${counts.animeTags.toLocaleString()} anime_tags, ${counts.animeStudios.toLocaleString()} anime_studios`);
  if (skippedNoTitle) console.log(`  skipped ${skippedNoTitle} records with no title`);
}

// ---------- Phase B: per-anime synopsis enrichment ----------
async function runPhaseB(opts) {
  console.log('\nPhase B — fetching synopses and embedding...');

  // Candidate anime: any row without a synopsis_vec yet that has either
  // a mal_id (for Jikan) or a title (for Wikipedia).
  //
  // Ordering: mal_id ASC NULLS LAST.
  //   - mal_id is loosely chronological (older anime = lower id), and
  //     established old anime have richer MAL synopses and dedicated
  //     Wikipedia articles. Recent placeholders (10.0 average score
  //     from a single rating) don't dominate the early queue.
  //   - If the import dies partway through we have the classic catalog
  //     covered first, then progressively newer titles.
  //   - id ASC tiebreaker for deterministic resume.
  let sql = `
    SELECT id, mal_id, title_romaji
    FROM anime
    WHERE synopsis_vec IS NULL
      AND (mal_id IS NOT NULL OR title_romaji IS NOT NULL)
    ORDER BY mal_id ASC NULLS LAST, id ASC
  `;
  if (opts.limit) sql += ` LIMIT ${opts.limit}`;
  const candidates = db.prepare(sql).all();

  if (!candidates.length) {
    console.log('  no candidates to process. Done.');
    return;
  }

  // Resume is implicit — synopsis_vec IS NULL excludes anything completed
  // in a previous run, so `candidates` is already "just what's left."
  console.log(`  ${candidates.length.toLocaleString()} candidates to process`);
  const remaining = candidates;

  const updateAnime = db.prepare(`
    UPDATE anime
    SET synopsis_mal = ?, synopsis_wiki = ?, synopsis_vec = ?, synced_at = ?
    WHERE id = ?
  `);
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const selectTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const joinTag = db.prepare(
    'INSERT OR IGNORE INTO anime_tags (anime_id, tag_id) VALUES (?, ?)',
  );

  const t0 = Date.now();
  let processed = 0;
  let stats = { malHit: 0, wikiHit: 0, bothHit: 0, neitherHit: 0 };

  for (const anime of remaining) {
    if (typeof interrupted !== 'undefined' && interrupted) {
      console.warn('  loop exiting cleanly due to Ctrl-C.');
      break;
    }
    try {
      // Fire both fetches in parallel — each module's rate limiter
      // throttles independently of the other.
      const [jikan, wiki] = await Promise.all([
        anime.mal_id ? fetchJikan(anime.mal_id).catch((e) => {
          console.warn(`  jikan fail mal=${anime.mal_id}: ${e.message}`);
          return null;
        }) : null,
        anime.title_romaji ? fetchPlotSection(anime.title_romaji).catch((e) => {
          console.warn(`  wiki fail "${anime.title_romaji}": ${e.message}`);
          return null;
        }) : null,
      ]);

      const synopsisMal = jikan?.synopsis || null;
      const synopsisWiki = wiki?.text || null;

      const hasMal = !!synopsisMal;
      const hasWiki = !!synopsisWiki;
      if (hasMal && hasWiki) stats.bothHit++;
      else if (hasMal) stats.malHit++;
      else if (hasWiki) stats.wikiHit++;
      else stats.neitherHit++;

      // Embed whatever we got, average if both, write nothing if neither.
      // Require at least 20 useful chars to avoid embedding "N/A" / whitespace
      // / placeholder strings, which produce degenerate vectors.
      const useMal = synopsisMal && synopsisMal.trim().length >= 20;
      const useWiki = synopsisWiki && synopsisWiki.trim().length >= 20;
      const vectors = [];
      if (useMal) vectors.push(await embed(synopsisMal));
      if (useWiki) vectors.push(await embed(synopsisWiki));
      const synopsisVec = averageVectors(vectors);

      // Update inside its own transaction so a later crash leaves the
      // anime row consistent (either fully enriched or untouched).
      db.exec('BEGIN');
      try {
        updateAnime.run(synopsisMal, synopsisWiki, synopsisVec, now(), anime.id);

        // MAL themes + demographics → tags.
        if (jikan) {
          for (const t of jikan.themes || []) {
            const n = normalizeTag(t.name);
            if (!n) continue;
            insertTag.run(n);
            joinTag.run(anime.id, selectTag.get(n).id);
          }
          for (const d of jikan.demographics || []) {
            const n = normalizeTag(d.name);
            if (!n) continue;
            insertTag.run(n);
            joinTag.run(anime.id, selectTag.get(n).id);
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      console.error(`  unrecoverable error on anime id=${anime.id}: ${err.message}`);
      // Don't break the whole import — record the cursor and continue.
    }

    processed++;
    if (processed % 50 === 0 || processed === remaining.length) {
      saveCheckpoint({ phaseB: { lastProcessedId: anime.id, processed, ts: now() } });
      const elapsed = Date.now() - t0;
      const rate = processed / (elapsed / 1000); // anime/sec
      const etaMs = ((remaining.length - processed) / rate) * 1000;
      const rssMb = (process.memoryUsage().rss / 1e6).toFixed(0);
      console.log(
        `  ${processed}/${remaining.length} | ${stats.bothHit} both, ${stats.malHit} mal-only, ${stats.wikiHit} wiki-only, ${stats.neitherHit} miss | ETA ${fmtDuration(etaMs)} | rss ${rssMb}MB`,
      );
    }
    // Periodic WAL checkpoint stops the -wal file from growing unbounded
    // over a 6-9 hour write loop.
    if (processed % 500 === 0) {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        console.warn(`  wal_checkpoint failed (non-fatal): ${err.message}`);
      }
    }
  }

  console.log(`\n  Phase B complete in ${fmtDuration(Date.now() - t0)}`);
  console.log(`  coverage: ${stats.bothHit} both, ${stats.malHit} mal-only, ${stats.wikiHit} wiki-only, ${stats.neitherHit} no synopsis`);
}

// ---------- Phase C: relations ----------
function runPhaseC(records) {
  console.log('\nPhase C — resolving relations...');
  const t0 = Date.now();

  const animeRows = db
    .prepare('SELECT id, anilist_id, mal_id FROM anime')
    .all();
  const byAnilist = new Map();
  const byMal = new Map();
  for (const r of animeRows) {
    if (r.anilist_id != null) byAnilist.set(r.anilist_id, r.id);
    if (r.mal_id != null) byMal.set(r.mal_id, r.id);
  }

  const insertRel = db.prepare(
    `INSERT OR IGNORE INTO relations (anime_id, related_anime_id, relation_type)
     VALUES (?, ?, 'RELATED')`,
  );

  let inserted = 0;
  let skipped = 0;
  db.exec('BEGIN');
  try {
    for (const rec of records) {
      let sourceId = null;
      if (rec.anilist_id != null) sourceId = byAnilist.get(rec.anilist_id);
      if (!sourceId && rec.mal_id != null) sourceId = byMal.get(rec.mal_id);
      if (!sourceId) continue;

      for (const url of rec.related_urls || []) {
        let targetId = null;
        let m = url.match(/anilist\.co\/anime\/(\d+)/);
        if (m) targetId = byAnilist.get(parseInt(m[1], 10));
        if (!targetId) {
          m = url.match(/myanimelist\.net\/anime\/(\d+)/);
          if (m) targetId = byMal.get(parseInt(m[1], 10));
        }
        if (targetId && targetId !== sourceId) {
          insertRel.run(sourceId, targetId);
          inserted++;
        } else {
          skipped++;
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`  ${inserted.toLocaleString()} relations inserted, ${skipped.toLocaleString()} skipped (target not in catalog) in ${fmtDuration(Date.now() - t0)}`);
}

// Graceful Ctrl-C — finish the in-flight anime, then exit cleanly so the
// WAL is checkpointed and the DB is closed. Without this, killing the
// import mid-batch can leave the -wal file un-checkpointed (still
// recoverable, just messier).
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) {
    console.error('\nSecond Ctrl-C — exiting immediately.');
    process.exit(130);
  }
  interrupted = true;
  console.warn('\nCtrl-C received. Finishing the current anime, then exiting...');
});

// ---------- main ----------
(async () => {
  const opts = parseArgs(process.argv);
  if (opts.reset && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
    console.log('Checkpoint cleared.');
  }

  console.log('Loading offline-database snapshot...');
  const { lastUpdate, records } = await loadOfflineDb();
  console.log(`  ${records.length.toLocaleString()} records, snapshot ${lastUpdate}`);

  if (!opts.skipA) runPhaseA(records);
  await runPhaseB(opts);
  runPhaseC(records);

  // Final WAL checkpoint + clean close. better-sqlite3 closes the WAL on
  // db.close() but an explicit TRUNCATE first keeps the file tidy.
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log('\nImport complete.');
  if (interrupted) process.exit(130);
})().catch((err) => {
  console.error('\nImport failed:', err.message);
  if (err.stack) console.error(err.stack);
  try {
    db.close(); // flushes WAL before exit
  } catch {}
  process.exit(1);
});

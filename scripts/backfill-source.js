// scripts/backfill-source.js — fills anime.source (signal #7: manga / light
// novel / original / game…), the one gap Jikan still has to serve. Genres
// (signal #3) are NOT touched here — they're seeded instantly from tags by
// scripts/seed-genres-from-tags.js; a MAL genre crawl was attempted and
// abandoned (MAL genre ids collide with our genre table's ids).
//
// Hits Jikan once per anime with a mal_id and no source yet (~30K calls at
// ~55/min ≈ 8-9h). Resumable: checkpoint at db/source-backfill-progress.json.
// Run unattended (detached — survives the launching terminal/session):
//   nohup caffeinate -di node scripts/backfill-source.js >> db/source-backfill.log 2>&1 &
'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { fetchAnime } = require('../src/jikan');

// Background scripts + the dev server share this DB file — wait out short
// write locks instead of crashing on SQLITE_BUSY.
db.pragma('busy_timeout = 10000');

const CHECKPOINT = path.join(__dirname, '..', 'db', 'source-backfill-progress.json');
const setSource = db.prepare('UPDATE anime SET source = ? WHERE id = ?');

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).lastId || 0; }
  catch { return 0; }
}
function saveCheckpoint(lastId) {
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ lastId, at: new Date().toISOString() }));
}

(async () => {
  const startId = loadCheckpoint();
  const rows = db
    .prepare(
      `SELECT id, mal_id FROM anime
       WHERE mal_id IS NOT NULL AND source IS NULL AND id > ?
       ORDER BY id`
    )
    .all(startId);
  console.log(`backfill-source: ${rows.length} titles to process (resuming after id ${startId})`);
  console.log(`estimated: ~${Math.round((rows.length * 1.1) / 3600 * 10) / 10}h at ~55 req/min`);

  let done = 0;
  let misses = 0;
  for (const row of rows) {
    let detail = null;
    try {
      detail = await fetchAnime(row.mal_id);
    } catch (err) {
      console.warn(`  mal_id ${row.mal_id}: ${err.message}`);
    }
    if (detail && detail.source) setSource.run(detail.source, row.id);
    else misses += 1;
    done += 1;
    saveCheckpoint(row.id);
    if (done % 200 === 0) {
      console.log(`  ${done}/${rows.length} processed (${misses} without source) — ${new Date().toISOString()}`);
    }
  }

  const sourced = db.prepare('SELECT COUNT(*) AS n FROM anime WHERE source IS NOT NULL').get().n;
  console.log(`backfill-source: COMPLETE — ${sourced} anime now carry source material. ${misses} misses.`);
})().catch((err) => {
  console.error('backfill-source failed:', err.message);
  process.exit(1);
});

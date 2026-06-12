// scripts/backfill-popularity.js — fills anime.popularity (how many people
// track a title) from AniList in batches of 50 (~14 min for the full
// catalog's AniList rows). The data prerequisite for damped score ranking
// and signal #11's quality floor: without it, a 9.35 from a tiny devoted
// fanbase (MILGRAM) outranks Frieren's 9.12 from a vast one on every
// score-sorted surface. Rows with only a mal_id are covered separately by
// scripts/backfill-source.js (MAL `members`, same "people tracking" idea
// on MAL's larger scale — see the popularity column comment in schema.sql).
//
// Phase 2 (Jikan): rows with ONLY a mal_id that still lack popularity —
// normally scripts/backfill-source.js fills these (MAL `members`) as it
// crawls, so this phase only catches rows it passed before members
// extraction existed, plus stragglers. CAUTION: phase 2 shares Jikan's
// 60/min budget with backfill:source — run it after that crawl finishes,
// not alongside.
//
// Resumable via db/popularity-backfill-progress.json. Run:
//   npm run backfill:popularity
'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { fetchPopularityBatchByIds, ID_BATCH_SIZE } = require('../src/anilist');
const { fetchAnime } = require('../src/jikan');

db.pragma('busy_timeout = 10000');

const CHECKPOINT = path.join(__dirname, '..', 'db', 'popularity-backfill-progress.json');

const setPopularity = db.prepare('UPDATE anime SET popularity = ? WHERE id = ?');

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
      `SELECT id, anilist_id FROM anime
       WHERE anilist_id IS NOT NULL AND id > ?
       ORDER BY id`
    )
    .all(startId);
  console.log(`backfill-popularity: ${rows.length} titles (resuming after id ${startId})`);
  console.log(`estimated: ~${Math.ceil((rows.length / ID_BATCH_SIZE) * 2.2 / 60)} min at 27 req/min`);

  let filled = 0;
  let missing = 0;
  for (let i = 0; i < rows.length; i += ID_BATCH_SIZE) {
    const batch = rows.slice(i, i + ID_BATCH_SIZE);
    const media = await fetchPopularityBatchByIds(batch.map((r) => r.anilist_id));
    const byAnilistId = new Map(media.map((m) => [m.id, m.popularity]));

    for (const row of batch) {
      const pop = byAnilistId.get(row.anilist_id);
      if (typeof pop === 'number') {
        setPopularity.run(pop, row.id);
        filled += 1;
      } else {
        missing += 1; // deleted on AniList's side — the sweep's report covers these
      }
    }
    saveCheckpoint(batch[batch.length - 1].id);
    if ((i / ID_BATCH_SIZE) % 20 === 0) {
      console.log(`  ${Math.min(i + ID_BATCH_SIZE, rows.length)}/${rows.length} — filled ${filled}, missing ${missing}`);
    }
  }

  console.log(`backfill-popularity: AniList lane COMPLETE — filled ${filled}, ${missing} missing on AniList.`);

  // ---------- phase 2: Jikan leftovers (MAL-only rows still empty) ----------
  const leftovers = db
    .prepare(
      `SELECT id, mal_id FROM anime
       WHERE anilist_id IS NULL AND mal_id IS NOT NULL AND popularity IS NULL
       ORDER BY id`
    )
    .all();
  if (leftovers.length === 0) {
    console.log('backfill-popularity: no Jikan leftovers — done.');
    return;
  }
  console.log(`backfill-popularity: ${leftovers.length} MAL-only leftovers via Jikan (~${Math.ceil((leftovers.length * 1.1) / 60)} min)`);
  console.log('  (if backfill:source is still running, stop this and rerun later — shared 60/min budget)');

  let malFilled = 0;
  for (const row of leftovers) {
    let detail = null;
    try {
      detail = await fetchAnime(row.mal_id);
    } catch (err) {
      console.warn(`  mal_id ${row.mal_id}: ${err.message}`);
    }
    if (detail && detail.members !== null) {
      setPopularity.run(detail.members, row.id);
      malFilled += 1;
    }
    if (malFilled % 200 === 0 && malFilled > 0) {
      console.log(`  leftovers: ${malFilled}/${leftovers.length} filled`);
    }
  }
  console.log(`backfill-popularity: COMPLETE — ${malFilled}/${leftovers.length} leftovers filled via MAL members.`);
})().catch((err) => {
  console.error('backfill-popularity failed:', err.message);
  process.exit(1);
});

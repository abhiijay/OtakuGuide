// scripts/sweep-country.js — restores the Japan-only v1 promise. The
// offline-database aggregates donghua/aeni alongside Japanese anime, and
// strays (Kan Kluai, Release That Witch) reached our top lists. This sweep
// verifies every row with an anilist_id against AniList's countryOfOrigin
// (~410 batched requests ≈ 15 min) and:
//   - DELETEs rows with countryOfOrigin != 'JP' (FK cascades clean joins)
//   - sets is_adult = 1 where AniList flags it (belt for the query filter)
//   - reports ids AniList no longer knows (no action taken)
// Every action is appended to db/country-sweep-report.jsonl for review.
// Rows without an anilist_id can't be verified and are left untouched.
//
// Resumable via db/country-sweep-progress.json. Run:
//   npm run sweep:country
'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { fetchCountryBatchByIds, ID_BATCH_SIZE } = require('../src/anilist');

db.pragma('busy_timeout = 10000');

const CHECKPOINT = path.join(__dirname, '..', 'db', 'country-sweep-progress.json');
const REPORT = path.join(__dirname, '..', 'db', 'country-sweep-report.jsonl');

const deleteAnime = db.prepare('DELETE FROM anime WHERE id = ?');
const flagAdult = db.prepare('UPDATE anime SET is_adult = 1 WHERE id = ?');

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).lastId || 0; }
  catch { return 0; }
}
function saveCheckpoint(lastId) {
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ lastId, at: new Date().toISOString() }));
}
function report(entry) {
  fs.appendFileSync(REPORT, JSON.stringify(entry) + '\n');
}

(async () => {
  const startId = loadCheckpoint();
  const rows = db
    .prepare(
      `SELECT id, anilist_id, title_romaji FROM anime
       WHERE anilist_id IS NOT NULL AND id > ?
       ORDER BY id`
    )
    .all(startId);
  console.log(`sweep-country: ${rows.length} titles to verify (resuming after id ${startId})`);

  let removed = 0;
  let flagged = 0;
  let missing = 0;
  for (let i = 0; i < rows.length; i += ID_BATCH_SIZE) {
    const batch = rows.slice(i, i + ID_BATCH_SIZE);
    const media = await fetchCountryBatchByIds(batch.map((r) => r.anilist_id));
    const byAnilistId = new Map(media.map((m) => [m.id, m]));

    for (const row of batch) {
      const m = byAnilistId.get(row.anilist_id);
      if (!m) {
        missing += 1;
        report({ action: 'missing-on-anilist', id: row.id, anilist_id: row.anilist_id, title: row.title_romaji });
        continue;
      }
      if (m.countryOfOrigin && m.countryOfOrigin !== 'JP') {
        deleteAnime.run(row.id);
        removed += 1;
        // anilist_id doubles as a refresh tombstone — import --refresh
        // skips re-inserting ids reported here (see runPhaseARefresh).
        report({ action: 'deleted-non-jp', id: row.id, anilist_id: row.anilist_id, title: row.title_romaji, country: m.countryOfOrigin });
      } else if (m.isAdult) {
        flagAdult.run(row.id);
        flagged += 1;
        report({ action: 'flagged-adult', id: row.id, title: row.title_romaji });
      }
    }
    saveCheckpoint(batch[batch.length - 1].id);
    if ((i / ID_BATCH_SIZE) % 20 === 0) {
      console.log(`  ${Math.min(i + ID_BATCH_SIZE, rows.length)}/${rows.length} — removed ${removed}, flagged ${flagged}, missing ${missing}`);
    }
  }

  console.log(`sweep-country: COMPLETE — removed ${removed} non-JP, flagged ${flagged} adult, ${missing} missing on AniList.`);
  console.log(`full report: ${REPORT}`);
})().catch((err) => {
  console.error('sweep-country failed:', err.message);
  process.exit(1);
});

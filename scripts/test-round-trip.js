// scripts/test-round-trip.js
// Pre-flight integration test. Run with: npm run test:round-trip
//
// Wires src/anilist.js + src/embeddings.js + src/db.js together for ONE
// real anime. Inserts into every table the import script will touch
// (anime + the 4 lookup tables + the 4 join tables + a vector BLOB),
// reads back, runs vec_distance_cosine. Wrapped in a transaction with
// ROLLBACK at the end so the prod database stays empty.
//
// Catches: schema constraint failures, BLOB round-trip bugs, sqlite-vec
// integration issues, type-coercion surprises — anything that would
// only surface during the multi-hour real import.
//
// Does NOT test: relations / community_recommendations (those need
// other anime to exist as FK targets; the importer defers them to a
// second pass). The known-issue note at the bottom of this script
// flags how the importer will handle them.

'use strict';

const { db } = require('../src/db');
const { fetchAnimeBatchByIds } = require('../src/anilist');
const { embed, EMBED_BYTES } = require('../src/embeddings');

const now = () => new Date().toISOString();

// Strips AniList's HTML markup from synopsis text before embedding.
// AniList descriptions contain <br>, <i>, <b> tags inline. Token-budget
// is precious (model truncates past ~256 tokens), so we strip the
// markup first. Display layer will sanitize separately for safety.
function stripHtml(text) {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  // --- 1. Fetch ---
  console.log('Step 1: Fetch one anime from AniList (id=1)...');
  const batch = await fetchAnimeBatchByIds([1]);
  if (!batch.length) throw new Error('AniList returned no anime for id=1');
  const a = batch[0];
  console.log(`  ${a.title.romaji} (AniList id ${a.id}, MAL id ${a.idMal})`);

  // --- 2. Embed ---
  console.log('\nStep 2: Embed synopsis...');
  const cleanSynopsis = stripHtml(a.description);
  console.log(`  raw chars: ${a.description.length}, after strip: ${cleanSynopsis.length}`);
  const synopsisVec = await embed(cleanSynopsis);
  console.log(`  vec bytes: ${synopsisVec.length} (expected ${EMBED_BYTES})`);

  // --- 3-7. Insert, all in a transaction we'll roll back ---
  console.log('\nStep 3-7: Insert anime + lookups + joins (inside a ROLLBACK txn)...');
  db.exec('BEGIN');
  try {
    // 3. anime row
    const animeStmt = db.prepare(`
      INSERT INTO anime (
        anilist_id, mal_id,
        title_romaji, title_english, title_native,
        cover_image_url, banner_image_url, synopsis,
        format, source, episodes, duration_minutes, season, season_year, status,
        average_score, popularity, is_adult,
        synopsis_vec, created_at, synced_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    const r = animeStmt.run(
      a.id, a.idMal,
      a.title.romaji, a.title.english, a.title.native,
      a.coverImage?.large, a.bannerImage, a.description, // keep HTML in storage
      a.format, a.source, a.episodes, a.duration, a.season, a.seasonYear, a.status,
      a.averageScore, a.popularity, a.isAdult ? 1 : 0,
      synopsisVec, now(), now(),
    );
    const animeId = r.lastInsertRowid;
    console.log(`  anime row inserted, internal id=${animeId}`);

    // 4. genres + anime_genres
    const genreInsert = db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)');
    const genreSelect = db.prepare('SELECT id FROM genres WHERE name = ?');
    const joinGenre = db.prepare('INSERT OR IGNORE INTO anime_genres (anime_id, genre_id) VALUES (?, ?)');
    for (const g of a.genres) {
      genreInsert.run(g);
      joinGenre.run(animeId, genreSelect.get(g).id);
    }
    console.log(`  genres linked: ${a.genres.length} (${a.genres.join(', ')})`);

    // 5. tags + anime_tags
    const tagInsert = db.prepare(
      'INSERT OR IGNORE INTO tags (anilist_tag_id, name, category, is_adult) VALUES (?, ?, ?, ?)',
    );
    const tagSelect = db.prepare('SELECT id FROM tags WHERE anilist_tag_id = ?');
    const joinTag = db.prepare(
      'INSERT OR IGNORE INTO anime_tags (anime_id, tag_id, rank, is_general_spoiler, is_media_spoiler) VALUES (?, ?, ?, ?, ?)',
    );
    for (const t of a.tags) {
      tagInsert.run(t.id, t.name, t.category, t.isAdult ? 1 : 0);
      joinTag.run(animeId, tagSelect.get(t.id).id, t.rank, 0, 0);
    }
    console.log(`  tags linked: ${a.tags.length} (top: ${a.tags.slice(0, 3).map((t) => t.name).join(', ')})`);

    // 6. studios + anime_studios
    const studioInsert = db.prepare(
      'INSERT OR IGNORE INTO studios (anilist_studio_id, name) VALUES (?, ?)',
    );
    const studioSelect = db.prepare('SELECT id FROM studios WHERE anilist_studio_id = ?');
    const joinStudio = db.prepare(
      'INSERT OR IGNORE INTO anime_studios (anime_id, studio_id, is_main) VALUES (?, ?, ?)',
    );
    for (const edge of a.studios.edges) {
      studioInsert.run(edge.node.id, edge.node.name);
      joinStudio.run(animeId, studioSelect.get(edge.node.id).id, edge.isMain ? 1 : 0);
    }
    console.log(`  studios linked: ${a.studios.edges.length}`);

    // 7. characters + anime_characters
    const charInsert = db.prepare(`
      INSERT OR IGNORE INTO characters
        (anilist_character_id, name, name_native, image_url, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const charSelect = db.prepare('SELECT id FROM characters WHERE anilist_character_id = ?');
    const joinChar = db.prepare(
      'INSERT OR IGNORE INTO anime_characters (anime_id, character_id, role) VALUES (?, ?, ?)',
    );
    for (const edge of a.characters.edges) {
      charInsert.run(
        edge.node.id,
        edge.node.name?.full || null,
        edge.node.name?.native || null,
        edge.node.image?.large || null,
        now(),
      );
      joinChar.run(animeId, charSelect.get(edge.node.id).id, edge.role);
    }
    console.log(`  characters linked: ${a.characters.edges.length}`);

    // --- 8. Read back ---
    console.log('\nStep 8: Read back and verify...');
    const row = db
      .prepare(
        `SELECT id, anilist_id, title_romaji, length(synopsis_vec) AS vec_len
         FROM anime WHERE id = ?`,
      )
      .get(animeId);
    console.log(`  anime row: ${JSON.stringify(row)}`);
    if (row.vec_len !== EMBED_BYTES) {
      throw new Error(`Stored vec_len ${row.vec_len} != expected ${EMBED_BYTES}`);
    }

    const genreCount = db
      .prepare('SELECT COUNT(*) AS n FROM anime_genres WHERE anime_id = ?')
      .get(animeId).n;
    const tagCount = db
      .prepare('SELECT COUNT(*) AS n FROM anime_tags WHERE anime_id = ?')
      .get(animeId).n;
    const studioCount = db
      .prepare('SELECT COUNT(*) AS n FROM anime_studios WHERE anime_id = ?')
      .get(animeId).n;
    const charCount = db
      .prepare('SELECT COUNT(*) AS n FROM anime_characters WHERE anime_id = ?')
      .get(animeId).n;
    console.log(`  joins counted: ${genreCount} genres, ${tagCount} tags, ${studioCount} studios, ${charCount} characters`);

    // --- 9. sqlite-vec cosine works on stored BLOBs ---
    console.log('\nStep 9: vec_distance_cosine(stored, fresh)...');
    const dist = db
      .prepare('SELECT vec_distance_cosine(synopsis_vec, ?) AS d FROM anime WHERE id = ?')
      .get(synopsisVec, animeId).d;
    console.log(`  distance (should be ~0): ${dist.toExponential(3)}`);
    if (Math.abs(dist) > 1e-5) {
      throw new Error(`Self-distance ${dist} is not ~0 — sqlite-vec is reading the BLOB wrong`);
    }

    console.log('\nAll steps passed. Rolling back transaction.');
    db.exec('ROLLBACK');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // --- 10. Confirm prod DB is still empty ---
  const finalCount = db.prepare('SELECT COUNT(*) AS n FROM anime').get().n;
  console.log(`\nFinal anime row count: ${finalCount} (should be 0)`);
  if (finalCount !== 0) {
    throw new Error('ROLLBACK did not undo inserts — prod DB is polluted');
  }

  console.log('\nRound-trip pre-flight passed.');
  console.log('\nKnown issue flagged for the importer:');
  console.log('  relations + community_recommendations have FK constraints to anime(id).');
  console.log('  When importing anime A that references B, B may not be inserted yet.');
  console.log('  Importer must defer these to a second pass after ALL anime are in,');
  console.log('  filtering to only pairs where both AniList ids exist in our catalog.');
})().catch((err) => {
  console.error('\nRound-trip failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

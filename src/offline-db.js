// src/offline-db.js
// Loads the manami-project/anime-offline-database snapshot — our catalog
// skeleton. One JSON download (~10 MB) gives us every anime entry across
// MAL + AniList + AniDB + Kitsu, deduplicated, with cross-IDs.
//
// Cached at db/anime-offline-database.json (gitignored). Re-downloaded
// only if missing or older than MAX_AGE_DAYS.
//
// Exports:
//   loadOfflineDb({ force }) -> { lastUpdate, records: AnimeRecord[] }
//
// Each AnimeRecord is normalized into our schema's shape:
//   { anilist_id, mal_id, title, synonyms, format, episodes, duration_minutes,
//     season, season_year, status, average_score, cover_image_url,
//     studios, tags, related_urls }
//
// Notes:
//   - offline-DB does not provide popularity, banner image, native/english
//     title, character data, review text, or category info — those come
//     from later passes (Jikan, AniList on-demand) or aren't in v1.
//   - All countries included. We aren't enforcing Japan-only here because
//     offline-DB has no countryOfOrigin field. v1 catalog will include
//     donghua/aeni; the user already wanted those eventually anyway.

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'db', 'anime-offline-database.json');
// The minified JSON is only published as a release asset (not on master).
// "/releases/latest/download/" is a GitHub-supported alias that 302s to
// the latest release's asset — Node fetch follows the redirect chain.
// File is ~58 MB uncompressed (.zst variant exists if size becomes an issue).
const SOURCE_URL =
  'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
const MAX_AGE_DAYS = 7;
const USER_AGENT =
  'OtakuGuide/0.1 (+https://github.com/abhiijay/OtakuGuide; vinayak.abhiijay@gmail.com)';

// Map offline-DB enums to our schema vocabulary.
// offline-DB statuses (FINISHED|ONGOING|UPCOMING|UNKNOWN) vs ours
// (FINISHED|RELEASING|NOT_YET_RELEASED|CANCELLED|HIATUS).
const STATUS_MAP = {
  FINISHED: 'FINISHED',
  ONGOING: 'RELEASING',
  UPCOMING: 'NOT_YET_RELEASED',
  UNKNOWN: null,
};

// offline-DB types match our format vocabulary 1:1 except UNKNOWN.
const FORMAT_MAP = {
  TV: 'TV',
  MOVIE: 'MOVIE',
  OVA: 'OVA',
  ONA: 'ONA',
  SPECIAL: 'SPECIAL',
  TV_SHORT: 'TV_SHORT',
  MUSIC: 'MUSIC',
  UNKNOWN: null,
};

// Pull AniList + MAL IDs out of the `sources` URL array.
// We deliberately skip Kitsu (URLs use slugs, not IDs) and AniDB for v1.
function extractIds(sources) {
  let anilist_id = null;
  let mal_id = null;
  for (const url of sources) {
    let m = url.match(/anilist\.co\/anime\/(\d+)/);
    if (m) anilist_id = parseInt(m[1], 10);
    m = url.match(/myanimelist\.net\/anime\/(\d+)/);
    if (m) mal_id = parseInt(m[1], 10);
  }
  return { anilist_id, mal_id };
}

// Convert one raw offline-DB entry into our normalized AnimeRecord shape.
function normalize(raw) {
  const { anilist_id, mal_id } = extractIds(raw.sources || []);
  const season = raw.animeSeason?.season;
  return {
    anilist_id,
    mal_id,
    title: raw.title || null,
    synonyms: raw.synonyms || [],
    format: FORMAT_MAP[raw.type] ?? null,
    episodes: typeof raw.episodes === 'number' && raw.episodes > 0 ? raw.episodes : null,
    duration_minutes:
      raw.duration && raw.duration.unit === 'SECONDS' && raw.duration.value > 0
        ? Math.round(raw.duration.value / 60)
        : null,
    season: season && season !== 'UNDEFINED' ? season : null,
    season_year:
      typeof raw.animeSeason?.year === 'number' && raw.animeSeason.year > 0
        ? raw.animeSeason.year
        : null,
    status: STATUS_MAP[raw.status] ?? null,
    average_score:
      typeof raw.score?.arithmeticGeometricMean === 'number'
        ? raw.score.arithmeticGeometricMean
        : null,
    cover_image_url: raw.picture || null,
    studios: raw.studios || [],
    tags: raw.tags || [],
    related_urls: raw.relatedAnime || [],
  };
}

// Is the cached file fresh enough to skip downloading?
function isCacheFresh() {
  if (!fs.existsSync(CACHE_PATH)) return false;
  const ageMs = Date.now() - fs.statSync(CACHE_PATH).mtimeMs;
  return ageMs < MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

async function downloadSnapshot() {
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} from ${SOURCE_URL}`);
  }
  const text = await res.text();
  fs.writeFileSync(CACHE_PATH, text);
  return text;
}

// Public API. Returns { lastUpdate, records }.
async function loadOfflineDb({ force = false } = {}) {
  let text;
  if (!force && isCacheFresh()) {
    text = fs.readFileSync(CACHE_PATH, 'utf8');
  } else {
    text = await downloadSnapshot();
  }
  const json = JSON.parse(text);
  const records = json.data.map(normalize);
  return { lastUpdate: json.lastUpdate, records };
}

module.exports = { loadOfflineDb };

// ---------- smoke test ----------
// Run with: node src/offline-db.js
// Reports cache state, total count, ID coverage, format distribution,
// and a sample normalized record.
if (require.main === module) {
  (async () => {
    const cached = fs.existsSync(CACHE_PATH);
    const cacheKb = cached
      ? Math.round(fs.statSync(CACHE_PATH).size / 1024)
      : 0;
    console.log(`Cache: ${cached ? `${cacheKb} KB on disk` : 'missing — will download'}`);

    const t0 = Date.now();
    const { lastUpdate, records } = await loadOfflineDb();
    console.log(`Loaded ${records.length.toLocaleString()} records in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`Snapshot lastUpdate: ${lastUpdate}`);

    // Coverage check on the cross-IDs that matter to us.
    const withMal = records.filter((r) => r.mal_id != null).length;
    const withAnilist = records.filter((r) => r.anilist_id != null).length;
    const withBoth = records.filter((r) => r.mal_id != null && r.anilist_id != null).length;
    const pct = (n) => ((n / records.length) * 100).toFixed(1);
    console.log(`\nID coverage:`);
    console.log(`  MAL id:       ${withMal.toLocaleString()} (${pct(withMal)}%)`);
    console.log(`  AniList id:   ${withAnilist.toLocaleString()} (${pct(withAnilist)}%)`);
    console.log(`  both:         ${withBoth.toLocaleString()} (${pct(withBoth)}%)`);

    // Format distribution.
    const formats = {};
    for (const r of records) {
      const k = r.format ?? '(unknown)';
      formats[k] = (formats[k] || 0) + 1;
    }
    console.log(`\nFormat distribution:`);
    for (const [k, v] of Object.entries(formats).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(12)} ${String(v).padStart(7)} (${pct(v)}%)`);
    }

    // A real anime as a sample.
    const cowboyBebop = records.find((r) => r.mal_id === 1);
    console.log('\nSample (Cowboy Bebop, mal_id=1):');
    console.log(JSON.stringify(cowboyBebop, null, 2));
  })().catch((err) => {
    console.error('Smoke test failed:', err.message);
    process.exit(1);
  });
}

// src/anilist.js
// Single GraphQL client for AniList. The catalog import uses this to
// enumerate every Japanese anime in their database and pull the fields
// we need for the recommender.
//
// Design choices (locked 2026-06-10):
//   - One account, conservative 27 req/min ceiling. AniList's nominal
//     limit is 90/min but the API is currently in a DEGRADED state and
//     officially limited to 30/min (their docs). We target ~27/min
//     (1 request per 2200ms) to leave headroom for retries.
//   - Filters baked into the query string, not runtime params:
//     type=ANIME, countryOfOrigin=JP, isAdult=false. None change for v1.
//   - Reviews are NOT fetched here — they get a separate second pass in
//     scripts/import-anime.js so we don't bloat every batch query with
//     empty review arrays for obscure anime.
//
// PAGINATION: ID-enumeration via id_in batches.
//   AniList hard-caps `Page` depth at 5000 entries (page * perPage), AND
//   `pageInfo.total` is officially broken (their docs warn it returns
//   wrong values — only `hasNextPage` is reliable). A full-catalog crawl
//   via Page(page: N) is impossible. The idiomatic workaround, used by
//   manami-project (the canonical anime-offline-database aggregator), is
//   to enumerate AniList IDs:
//
//     const highestId = await fetchHighestAnimeId();
//     for (let i = 1; i <= highestId; i += 50) {
//       const ids = Array.from({ length: 50 }, (_, k) => i + k);
//       const batch = await fetchAnimeBatchByIds(ids);
//       // anime that don't exist, or that fail filters (non-JP, adult,
//       // manga), are silently absent from batch.media — record them
//       // as "skip" so we don't retry on resume.
//     }
//
//   Page depth stays at 1 forever; the 5000 cap never fires.
//   Reference: github.com/manami-project/modb-app (Kotlin, same pattern).
//
// What this file does NOT do:
//   - It does not write to the database. fetchAnimeBatchByIds returns
//     raw AniList objects; transforming them into schema rows is the
//     import script's job. Network in, plain objects out.
//   - It does not track which IDs are "dead" or "skip". That belongs
//     in scripts/import-anime.js's checkpoint file.

'use strict';

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

// AniList API is currently degraded to 30 req/min (per their docs at
// docs.anilist.co/guide/rate-limiting). We target ~27 req/min — 1 request
// per 2200ms — to leave headroom for retries.
const MIN_INTERVAL_MS = 2200;

// Retry policy for transient errors (HTTP 429, 500-503).
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

// Batches of up to 50 anime IDs per request. Page depth stays at 1, so
// the 5000-entry depth cap doesn't bite. Missing IDs (deleted, manga,
// non-Japanese, adult) are silently absent from the response.
const ID_BATCH_SIZE = 50;

// One-shot probe query for the highest AniList anime ID in existence.
// Used to bound the ID-enumeration loop. Result lives in the import
// script's checkpoint, so we only call this once per import run.
const HIGHEST_ID_QUERY = `
  query HighestAnimeId {
    Page(page: 1, perPage: 1) {
      media(type: ANIME, sort: ID_DESC) {
        id
      }
    }
  }
`;

// The main batch query. Fields chosen 2026-06-10 to map onto the 12
// signals + every column in db/schema.sql. If you add a column, add the
// field here; if you remove one, prune it here too.
//
// $ids is an array of up to 50 AniList IDs. Filters (countryOfOrigin,
// isAdult) silently exclude non-matching IDs — the response contains
// only entries that pass all filters.
const ANIME_BATCH_QUERY = `
  query AnimeBatch($ids: [Int!]!) {
    Page(page: 1, perPage: 50) {
      media(
        type: ANIME
        countryOfOrigin: "JP"
        isAdult: false
        id_in: $ids
      ) {
        id
        idMal
        title { romaji english native }
        description(asHtml: false)
        coverImage { large extraLarge }
        bannerImage
        episodes
        duration
        season
        seasonYear
        format
        source
        status
        averageScore
        popularity
        isAdult
        genres
        tags { id name category rank isAdult }
        studios {
          edges {
            isMain
            node { id name }
          }
        }
        characters(perPage: 10, sort: ROLE) {
          edges {
            role
            node {
              id
              name { full native }
              image { large }
            }
          }
        }
        relations {
          edges {
            relationType
            node { id }
          }
        }
        recommendations(perPage: 10, sort: RATING_DESC) {
          nodes {
            rating
            mediaRecommendation { id }
          }
        }
      }
    }
  }
`;

// Seasonal page query — everything airing/released in one season. Used by
// scripts/sync-recent.js to keep the newest titles fresh while the
// offline-database snapshot lags (its "latest" release sat 10 weeks stale
// on 2026-06-12). One season is ~300-500 titles ≈ ≤10 pages — Page depth
// stays far under the 5000 cap, and hasNextPage (the one reliable
// pageInfo field) bounds the loop. This is client-scale use, not the
// bulk collection AniList's TOS forbids.
// Fields are the batch query's MINUS characters/relations/recommendations
// (not needed for a freshness sync — keeps the response light).
const SEASON_PAGE_QUERY = `
  query SeasonPage($season: MediaSeason!, $year: Int!, $page: Int!) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      media(
        type: ANIME
        countryOfOrigin: "JP"
        isAdult: false
        season: $season
        seasonYear: $year
      ) {
        id
        idMal
        title { romaji english native }
        coverImage { large extraLarge }
        bannerImage
        episodes
        duration
        season
        seasonYear
        format
        source
        status
        averageScore
        popularity
        genres
        tags { name isAdult }
        studios {
          edges {
            isMain
            node { name }
          }
        }
      }
    }
  }
`;

// Lightweight verification query — country + adult flag only, WITHOUT the
// baked-in filters, so the caller can see WHY an id doesn't belong
// (non-JP vs adult). Used by scripts/sweep-country.js.
const COUNTRY_BATCH_QUERY = `
  query CountryBatch($ids: [Int!]!) {
    Page(page: 1, perPage: 50) {
      media(type: ANIME, id_in: $ids) {
        id
        countryOfOrigin
        isAdult
      }
    }
  }
`;

// Popularity (how many AniList users track the title) — the vote-count
// proxy for damped score ranking + signal #11's quality floor. Fetched
// without standing filters, same shape as the country sweep.
const POPULARITY_BATCH_QUERY = `
  query PopularityBatch($ids: [Int!]!) {
    Page(page: 1, perPage: 50) {
      media(type: ANIME, id_in: $ids) {
        id
        popularity
      }
    }
  }
`;

// ---------- rate limiter ----------
// Module-level timestamp of the last request. waitForSlot() sleeps until
// at least MIN_INTERVAL_MS has elapsed since this value, then stamps it.
// Single-process only — if we ever fork workers, switch to a shared
// store (Redis, file lock, etc.).
let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSlot() {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

// ---------- HTTP with retry ----------
// AniList returns 429 with a Retry-After header when rate-limited, and
// 5xx for transient server errors. Retry both with exponential backoff,
// honoring Retry-After when present.
async function fetchWithRetry(body) {
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForSlot();

    const res = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt === MAX_RETRIES) {
      const text = await res.text();
      throw new Error(`AniList ${res.status}: ${text.slice(0, 200)}`);
    }

    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : backoff;
    console.warn(
      `AniList ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(waitMs);
    backoff *= 2;
  }
}

// ---------- public API ----------

// Returns the highest AniList anime ID currently in their database.
// Used once per import run to bound the enumeration loop.
async function fetchHighestAnimeId() {
  const data = await fetchWithRetry({ query: HIGHEST_ID_QUERY });

  if (data.errors) {
    throw new Error(`AniList GraphQL: ${JSON.stringify(data.errors)}`);
  }

  const media = data.data.Page.media;
  if (!media.length) {
    throw new Error('AniList returned no media for highest-id probe');
  }
  return media[0].id;
}

// Fetches up to 50 anime by ID, applying our standing filters
// (Japanese, non-adult). IDs that don't exist, or that match a filter
// reject, are silently absent from the response. The caller is
// responsible for diffing the requested IDs vs the returned IDs to
// track "skip" entries.
//
// Returns the raw `media` array: [{ id, idMal, title, ... }, ...]
async function fetchAnimeBatchByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('fetchAnimeBatchByIds requires a non-empty array of IDs');
  }
  if (ids.length > ID_BATCH_SIZE) {
    throw new Error(`Batch size ${ids.length} exceeds limit of ${ID_BATCH_SIZE}`);
  }

  const data = await fetchWithRetry({
    query: ANIME_BATCH_QUERY,
    variables: { ids },
  });

  if (data.errors) {
    throw new Error(`AniList GraphQL: ${JSON.stringify(data.errors)}`);
  }

  return data.data.Page.media;
}

// Fetches { id, countryOfOrigin, isAdult } for up to 50 AniList IDs with
// NO standing filters — ids absent from the response are deleted on
// AniList's side. Used by the country sweep.
async function fetchCountryBatchByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > ID_BATCH_SIZE) {
    throw new Error(`fetchCountryBatchByIds requires 1-${ID_BATCH_SIZE} ids`);
  }
  const data = await fetchWithRetry({ query: COUNTRY_BATCH_QUERY, variables: { ids } });
  if (data.errors) {
    throw new Error(`AniList GraphQL: ${JSON.stringify(data.errors)}`);
  }
  return data.data.Page.media;
}

// Fetches { id, popularity } for up to 50 AniList IDs, no standing
// filters — ids absent from the response are deleted on AniList's side.
// Used by scripts/backfill-popularity.js.
async function fetchPopularityBatchByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > ID_BATCH_SIZE) {
    throw new Error(`fetchPopularityBatchByIds requires 1-${ID_BATCH_SIZE} ids`);
  }
  const data = await fetchWithRetry({ query: POPULARITY_BATCH_QUERY, variables: { ids } });
  if (data.errors) {
    throw new Error(`AniList GraphQL: ${JSON.stringify(data.errors)}`);
  }
  return data.data.Page.media;
}

// Fetches one page of a season's anime (50 per page). Returns
// { media, hasNextPage } — loop pages until hasNextPage is false.
async function fetchSeasonPage(season, year, page) {
  const data = await fetchWithRetry({
    query: SEASON_PAGE_QUERY,
    variables: { season, year, page },
  });
  if (data.errors) {
    throw new Error(`AniList GraphQL: ${JSON.stringify(data.errors)}`);
  }
  return {
    media: data.data.Page.media,
    hasNextPage: data.data.Page.pageInfo.hasNextPage,
  };
}

module.exports = {
  fetchHighestAnimeId,
  fetchAnimeBatchByIds,
  fetchCountryBatchByIds,
  fetchPopularityBatchByIds,
  fetchSeasonPage,
  ID_BATCH_SIZE,
};

// ---------- smoke test ----------
// Run with: node src/anilist.js
// Probes: (1) highestId detection, (2) a batch in the well-populated mid
// range, (3) field-coverage scan to surface data gaps.
if (require.main === module) {
  (async () => {
    console.log('PROBE 1 — fetchHighestAnimeId()');
    const highestId = await fetchHighestAnimeId();
    console.log(`  highest AniList anime id: ${highestId}`);
    console.log(`  estimated cold-crawl: ${Math.ceil(highestId / ID_BATCH_SIZE)} requests`);
    console.log(
      `  estimated time at ~27 req/min: ~${Math.ceil(
        highestId / ID_BATCH_SIZE / 27,
      )} minutes`,
    );

    // Probe a well-populated mid-range slice (older established anime).
    const startId = 1;
    const batchIds = Array.from({ length: ID_BATCH_SIZE }, (_, k) => startId + k);
    console.log(`\nPROBE 2 — fetchAnimeBatchByIds([${batchIds[0]}..${batchIds[batchIds.length - 1]}])`);
    const batch = await fetchAnimeBatchByIds(batchIds);
    const returnedIds = new Set(batch.map((m) => m.id));
    const missingIds = batchIds.filter((id) => !returnedIds.has(id));
    console.log(`  requested: ${batchIds.length}, returned: ${batch.length}`);
    console.log(`  missing (deleted / manga / non-JP / adult): ${missingIds.length}`);
    if (batch.length) {
      const first = batch[0];
      console.log(`  first returned: ${first.title.romaji} (id ${first.id}, year ${first.seasonYear})`);
    }

    // Probe a slice in the densely-populated 100k range.
    const midStart = 100000;
    const midIds = Array.from({ length: ID_BATCH_SIZE }, (_, k) => midStart + k);
    console.log(`\nPROBE 3 — fetchAnimeBatchByIds([${midIds[0]}..${midIds[midIds.length - 1]}])`);
    const mid = await fetchAnimeBatchByIds(midIds);
    console.log(`  requested: ${midIds.length}, returned: ${mid.length}`);
    if (mid.length) {
      console.log(`  sample: ${mid[0].title.romaji} (id ${mid[0].id}, year ${mid[0].seasonYear})`);
    }

    // Field coverage across whichever probe returned more entries.
    const sample = mid.length > batch.length ? mid : batch;
    if (!sample.length) {
      console.log('\nNo entries returned — skipping field-coverage scan.');
      return;
    }
    console.log(`\nFIELD COVERAGE — across ${sample.length} anime:`);
    const counters = {
      idMal: 0,
      titleRomaji: 0,
      titleEnglish: 0,
      titleNative: 0,
      description: 0,
      coverImage: 0,
      bannerImage: 0,
      episodes: 0,
      duration: 0,
      season: 0,
      seasonYear: 0,
      format: 0,
      source: 0,
      status: 0,
      averageScore: 0,
      popularity: 0,
      genres: 0,
      tags: 0,
      studios: 0,
      characters: 0,
      relations: 0,
      recommendations: 0,
    };
    for (const m of sample) {
      if (m.idMal != null) counters.idMal++;
      if (m.title?.romaji) counters.titleRomaji++;
      if (m.title?.english) counters.titleEnglish++;
      if (m.title?.native) counters.titleNative++;
      if (m.description) counters.description++;
      if (m.coverImage?.large) counters.coverImage++;
      if (m.bannerImage) counters.bannerImage++;
      if (m.episodes != null) counters.episodes++;
      if (m.duration != null) counters.duration++;
      if (m.season) counters.season++;
      if (m.seasonYear != null) counters.seasonYear++;
      if (m.format) counters.format++;
      if (m.source) counters.source++;
      if (m.status) counters.status++;
      if (m.averageScore != null) counters.averageScore++;
      if (m.popularity != null) counters.popularity++;
      if (m.genres?.length) counters.genres++;
      if (m.tags?.length) counters.tags++;
      if (m.studios?.edges?.length) counters.studios++;
      if (m.characters?.edges?.length) counters.characters++;
      if (m.relations?.edges?.length) counters.relations++;
      if (m.recommendations?.nodes?.length) counters.recommendations++;
    }
    const n = sample.length;
    for (const [k, v] of Object.entries(counters)) {
      const pct = ((v / n) * 100).toFixed(0).padStart(3);
      const bar = '█'.repeat(Math.round((v / n) * 20)).padEnd(20, '░');
      console.log(`  ${k.padEnd(16)} ${bar} ${pct}% (${v}/${n})`);
    }
  })().catch((err) => {
    console.error('Smoke test failed:', err.message);
    process.exit(1);
  });
}

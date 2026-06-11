// src/jikan.js
// MAL synopsis fetcher via Jikan (the unofficial MyAnimeList REST API).
// `GET /v4/anime/{mal_id}` returns the synopsis plus genres, themes and
// demographics — four signals from one call.
//
// Rate limit: Jikan advertises 3 req/sec AND 60 req/min — the per-minute
// cap is the binding one for long crawls. We target ~55 req/min.
//
// Exports:
//   fetchAnime(mal_id) -> { synopsis, source, genres, themes, demographics } | null
//
// Returns null for 404 (anime not in MAL) so callers can advance their
// checkpoint without retrying. All other errors throw.

'use strict';

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const MIN_INTERVAL_MS = 1100; // ~55 req/min — under Jikan's 60/min cap.
// 700ms looked fine per-second but is ~85/min, so the minute limiter fired
// constantly (see db/source-backfill.log) — every 429 costs a request plus
// a 2s penalty, so 1100ms is no slower in practice and far politer.
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;
const USER_AGENT =
  'OtakuGuide/0.1 (+https://github.com/abhiijay/OtakuGuide; vinayak.abhiijay@gmail.com)';

// MAL synopses commonly end with attribution like:
//   "[Written by MAL Rewrite]"
//   "(Source: ANN)"
//   "(Source: MU)"
// We strip these so they don't pollute the embedding vector with
// source-identification patterns.
const ATTRIBUTION_RE = /\s*(\[Written by[^\]]*\]|\(Source:[^)]*\))\s*$/gi;

function stripAttribution(text) {
  if (!text) return text;
  let out = text;
  // Loop in case there's more than one trailing tag (rare but possible).
  while (ATTRIBUTION_RE.test(out)) {
    out = out.replace(ATTRIBUTION_RE, '');
  }
  return out.trim();
}

// ---------- rate limiter ----------
// Same single-process token-bucket pattern as src/anilist.js. If we ever
// fork workers, switch to a shared store.
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
// 404 returns null (caller treats as "anime not in MAL"). 429 honors
// Retry-After. 5xx + network errors get exponential backoff.
async function fetchWithRetry(url) {
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForSlot();

    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000), // hung-connection guard
      });
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`Jikan network error, retrying in ${backoff}ms: ${err.message}`);
      await sleep(backoff);
      backoff *= 2;
      continue;
    }

    if (res.status === 404) return null;
    if (res.ok) return res.json();

    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt === MAX_RETRIES) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jikan ${res.status}: ${text.slice(0, 200)}`);
    }

    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : backoff;
    console.warn(
      `Jikan ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(waitMs);
    backoff *= 2;
  }
  // Defensive: the loop should never fall through (the final attempt
  // throws via the !retryable || attempt === MAX_RETRIES branch above),
  // but if it ever does, throw rather than returning undefined.
  throw new Error('Jikan retries exhausted');
}

// ---------- public API ----------

// Fetches one anime's MAL detail. Returns:
//   { synopsis, genres, themes, demographics }   on success
//   null                                          if MAL has no entry (404)
//
// `synopsis` is plain English text with attribution tags stripped.
// `genres`, `themes` and `demographics` are arrays of { mal_id, name }
// objects (e.g. [{ mal_id: 1, name: 'Action' }], [{ mal_id: 27, name: 'Shounen' }]).
// `genres` is MAL's curated ~20-genre list — distinct from themes, which
// are finer-grained descriptors.
async function fetchAnime(mal_id) {
  if (typeof mal_id !== 'number' || mal_id <= 0) {
    throw new Error(`fetchAnime(mal_id) requires a positive integer, got ${mal_id}`);
  }

  const body = await fetchWithRetry(`${JIKAN_BASE}/anime/${mal_id}`);
  if (body === null) return null;

  const d = body.data;
  // Jikan returns 200 + { type, message } (no `.data`) for some unknown
  // IDs instead of a clean 404. Treat that as "not found" too so we
  // don't choke the importer on a single missing entry.
  if (!d) return null;

  return {
    synopsis: stripAttribution(d.synopsis || ''),
    source: d.source || null, // 'Manga' | 'Light novel' | 'Original' | ... — signal #7
    genres: (d.genres || []).map((t) => ({ mal_id: t.mal_id, name: t.name })),
    themes: (d.themes || []).map((t) => ({ mal_id: t.mal_id, name: t.name })),
    demographics: (d.demographics || []).map((t) => ({ mal_id: t.mal_id, name: t.name })),
  };
}

module.exports = { fetchAnime, stripAttribution };

// ---------- smoke test ----------
// Run with: node src/jikan.js
// Fetches Cowboy Bebop + Mob Psycho 100 to verify (1) the synopsis pipeline,
// (2) attribution stripping, (3) themes + demographics shape.
if (require.main === module) {
  (async () => {
    const cases = [
      { mal_id: 1, name: 'Cowboy Bebop' },
      { mal_id: 32182, name: 'Mob Psycho 100' },
      { mal_id: 99999999, name: 'Bogus ID (expect null)' },
    ];

    for (const c of cases) {
      const t0 = Date.now();
      const result = await fetchAnime(c.mal_id);
      const ms = Date.now() - t0;
      console.log(`\n${c.name} (mal_id ${c.mal_id}) — ${ms}ms`);
      if (result === null) {
        console.log('  -> null (404, as expected)');
        continue;
      }
      console.log(`  synopsis: ${result.synopsis.length} chars`);
      console.log(`  preview:  ${result.synopsis.slice(0, 120)}...`);
      console.log(`  genres:   [${result.genres.map((t) => t.name).join(', ')}]`);
      console.log(`  themes:   [${result.themes.map((t) => t.name).join(', ')}]`);
      console.log(`  demogs:   [${result.demographics.map((t) => t.name).join(', ')}]`);
      const stillAttributed = /\[Written by|\(Source:/.test(result.synopsis);
      if (stillAttributed) console.log('  WARNING: attribution slipped through');
    }
  })().catch((err) => {
    console.error('\nSmoke test failed:', err.message);
    process.exit(1);
  });
}

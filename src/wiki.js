// src/wiki.js
// Fetches the "Plot" section text from an anime's Wikipedia article.
// Encyclopedic, structure-focused — deliberately stylistically distinct
// from MAL's fan-prose synopsis (see CLAUDE.md "Architecture pivot").
//
// Strategy:
//   1) GET ?action=parse&prop=sections — list all section headings
//   2) find the first top-level (toclevel == 1) section whose heading
//      matches one of our plot synonyms ("Plot", "Synopsis", ...)
//   3) GET ?action=parse&section=<index>&prop=text — fetch that section's HTML
//   4) strip Wikipedia noise (citations, edit links, hatnotes, tables, CSS),
//      then strip all remaining HTML tags
//
// Rate limit:
//   No published cap, but the polite norm for the MediaWiki API is ~5 req/sec
//   from a single client. We target one request per 200ms; the importer can
//   parallelize within that budget.
//
// Exports:
//   fetchPlotSection(title) -> { text, sectionTitle } | null
//   - Returns null if the article doesn't exist, has no plot-equivalent
//     section, or returned a disambig page.
//   - `text` is plain prose; entities decoded; whitespace collapsed.

'use strict';

const API_BASE = 'https://en.wikipedia.org/w/api.php';
const MIN_INTERVAL_MS = 200; // ~5 req/sec polite ceiling
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 1500;
const USER_AGENT =
  'OtakuGuide/0.1 (+https://github.com/abhiijay/OtakuGuide; vinayak.abhiijay@gmail.com)';

// Section headings we'll accept, in priority order. All compared
// case-insensitive after trim. Top-level (toclevel === 1) only — nested
// per-season plot summaries are usually too narrow.
const PLOT_SECTION_NAMES = ['plot', 'synopsis', 'story', 'storyline', 'premise'];

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

async function fetchJson(url) {
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForSlot();

    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`Wikipedia network error, retrying in ${backoff}ms: ${err.message}`);
      await sleep(backoff);
      backoff *= 2;
      continue;
    }

    if (res.ok) return res.json();

    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt === MAX_RETRIES) {
      const text = await res.text().catch(() => '');
      throw new Error(`Wikipedia ${res.status}: ${text.slice(0, 200)}`);
    }

    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : backoff;
    console.warn(
      `Wikipedia ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(waitMs);
    backoff *= 2;
  }
}

// MediaWiki uses underscore-separated titles. Don't double-encode spaces.
function toSlug(title) {
  return encodeURIComponent(title.replace(/ /g, '_'));
}

// Remove Wikipedia's structural noise. Order matters: container elements
// (style, sup, table, span.mw-editsection, div hatnotes) must be killed
// BEFORE we strip all remaining tags, otherwise their text content leaks.
function stripWikiHtml(html) {
  return html
    // Strip the WHOLE heading container first — MediaWiki wraps the h-tag
    // and its "edit" span together as <div class="mw-heading">…</div>.
    // Killing this in one shot avoids the nested-span pitfall (the editsection
    // span contains its own nested spans, so a naive non-greedy match leaks).
    .replace(/<div class="mw-heading[\s\S]*?<\/div>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<sup[\s\S]*?<\/sup>/gi, '') // [1] citations
    .replace(/<table[\s\S]*?<\/table>/gi, '')
    .replace(/<span class="mw-editsection[\s\S]*?<\/span>\s*<\/span>/gi, '') // legacy fallback
    .replace(/<div role="note"[\s\S]*?<\/div>/gi, '') // hatnotes
    .replace(/<div class="hatnote[\s\S]*?<\/div>/gi, '')
    .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, '') // bare headings, just in case
    .replace(/\[edit\]/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Public API.
async function fetchPlotSection(title) {
  if (!title || typeof title !== 'string') {
    throw new Error('fetchPlotSection requires a non-empty title string');
  }
  const slug = toSlug(title);

  const secUrl =
    `${API_BASE}?action=parse&page=${slug}&format=json&prop=sections&disablelimitreport=1`;
  const secJson = await fetchJson(secUrl);

  // Article missing or disambig: `parse` is undefined OR sections empty.
  if (!secJson.parse || !Array.isArray(secJson.parse.sections)) return null;

  const match = secJson.parse.sections.find(
    (s) => s.toclevel === 1 && PLOT_SECTION_NAMES.includes(s.line.toLowerCase().trim()),
  );
  if (!match) return null;

  const txtUrl =
    `${API_BASE}?action=parse&page=${slug}&section=${match.index}` +
    `&format=json&prop=text&disablelimitreport=1`;
  const txtJson = await fetchJson(txtUrl);
  const html = txtJson?.parse?.text?.['*'];
  if (!html) return null;

  const text = stripWikiHtml(html);
  if (!text) return null;
  return { text, sectionTitle: match.line };
}

module.exports = { fetchPlotSection };

// ---------- smoke test ----------
// Run with: node src/wiki.js
// Probes one mainstream, one mid-tier, one likely-missing.
if (require.main === module) {
  (async () => {
    const cases = [
      'Cowboy Bebop',
      'Mob Psycho 100',
      'Made in Abyss',
      'Tatami Galaxy', // mid-tier; testing fallback synonym
      'NonexistentAnimeTitle12345xyz', // expect null
    ];

    for (const title of cases) {
      const t0 = Date.now();
      const result = await fetchPlotSection(title);
      const ms = Date.now() - t0;
      console.log(`\n"${title}" — ${ms}ms`);
      if (!result) {
        console.log('  -> null (no plot section)');
        continue;
      }
      console.log(`  section heading: "${result.sectionTitle}"`);
      console.log(`  text: ${result.text.length} chars`);
      console.log(`  preview: ${result.text.slice(0, 150)}...`);
    }
  })().catch((err) => {
    console.error('\nSmoke test failed:', err.message);
    process.exit(1);
  });
}

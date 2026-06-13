// src/covers.js — shared cover-image helpers.
//
// Extracted from src/routes/pages.js so the JSON API (src/routes/api.js) can
// produce the same sharp poster URLs without duplicating the MAL size-swap
// logic. Pure string work; no DB, no I/O.
'use strict';

// largeCover(url) — upgrade a MAL cover to its larger variant. MAL serves
// covers in several sizes; the catalog stores the default (~225px wide). The
// 'l' variant (~425px) keeps large renders sharp. Some entries lack the
// variant — callers fall back to the original via an <img onerror>.
// AniList-hosted covers (rows from sync-recent) have no size-suffix trick;
// transforming them would just guarantee a 404 round-trip, so pass them
// through — those rows carry cover_image_xl anyway.
function largeCover(url) {
  if (!url || !url.includes('myanimelist')) return url;
  return url.replace(/\.(jpe?g|png|webp)$/i, 'l.$1');
}

module.exports = { largeCover };

// src/signals.js — the canonical twelve-signal list, in display order.
// Single source of truth for BOTH status grids (home page + /how-it-works),
// which drifted apart when statuses lived inline in each view. Update a
// signal's status here the same commit its wiring lands in src/recommender.js.
//
// status values the views understand:
//   'live'         — wired into recommendFromAnime and contributing now
//   'ready'        — data is in the DB, wiring not written yet
//   'data gap'     — blocked on missing data
//   'v2'           — deliberately deferred (see CLAUDE.md signal table)
//   'waits: users' — needs user watch data that doesn't exist yet

'use strict';

const SIGNALS = [
  {
    name: 'synopsis embedding', kanji: '梗概', status: 'live',
    blurb: 'The headline signal. Both synopses embedded, averaged, compared by cosine similarity — matches stories by meaning, not keywords.',
  },
  {
    name: 'tag tf-idf', kanji: '札', status: 'live',
    blurb: 'Community tags weighted by rarity (TF-IDF), with 49 alias rules so "sci-fi" and "science fiction" count as one tag, not two strangers.',
  },
  {
    name: 'genre overlap', kanji: '類', status: 'live',
    blurb: 'Eighteen canonical genres, recovered from the tag namespace. Scores how much two genre sets overlap — built to resist genre-spam.',
  },
  {
    name: 'studio', kanji: '社', status: 'live',
    blurb: 'ufotable, KyoAni and MAPPA each cluster recognizably. Shared studios weighted by rarity — sharing Toei says little, sharing ufotable says a lot.',
  },
  {
    name: 'era', kanji: '時代', status: 'live',
    blurb: "A '90s cel classic and a 2020s production differ structurally. Same year scores full marks, fading to nothing across two decades.",
  },
  {
    name: 'episode buckets', kanji: '話数', status: 'live',
    blurb: 'Movie / short / single-cour / long-runner — pacing implies commitment. Adjacent buckets get half credit.',
  },
  {
    name: 'source material', kanji: '原作', status: 'live',
    blurb: 'Manga, light-novel, game and original works have different DNA. Live now; coverage grows as an overnight crawl fills in the data.',
  },
  {
    name: 'format', kanji: '形式', status: 'live',
    blurb: 'TV / movie / OVA / ONA / special. Exact match scores full; sibling formats (TV↔ONA, OVA↔special) score half.',
  },
  {
    name: 'character vectors', kanji: '人物', status: 'v2',
    blurb: '"Find anime with characters like Naruto." Needs a separate per-anime fetch — deferred to v2.',
  },
  {
    name: 'review vectors', kanji: '批評', status: 'v2',
    blurb: 'Embedding what reviewers say captures humor and tone without an LLM. Deferred to v2.',
  },
  {
    name: 'popularity re-rank', kanji: '人気', status: 'waits: users',
    blurb: 'Never part of similarity — used afterwards for a quality floor and a serendipity boost for hidden gems. Needs user data.',
  },
  {
    name: 'relations filter', kanji: '関係', status: 'waits: users',
    blurb: 'Discover-mode will exclude sequels of things you already watched. Needs your watch history to exist first.',
  },
];

module.exports = { SIGNALS };

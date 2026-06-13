// scripts/flag-adult.js — sets anime.is_adult = 1 for every title carrying the
// `hentai` tag. Run after any catalog import; idempotent.
//
// Why this exists: the import flags adult content via AniList's `isAdult` flag,
// but MAL-only / recent OVAs (no anilist_id, so AniList's flag never reaches
// them) slip through with is_adult = 0. On 2026-06-14 a batch of hentai OVAs
// (Saint Lime, Kyou wa Yubiwa wo Hazusu kara, L'amour fou de l'automate, …)
// were found leaking onto /catalog and /airing, which filter only on
// is_adult = 0. The `hentai` tag (aggregated across MAL/AniList/Kitsu/AniDB by
// the offline-database) is the precise signal: it covers genuine pornography
// without touching the gore/violence seinen the project deliberately keeps
// (Berserk, Chainsaw Man, Devilman Crybaby — none carry the `hentai` tag).
//
// Deliberately NOT used: `erotica` / `nudity` / `sex`. Those tags sit on legit
// mainstream titles (Devilman Crybaby and Kuzu no Honkai are tagged `erotica`;
// Berserk carries `nudity` + `sex`), so flagging them would delete content the
// catalog is meant to keep. If a softer-adult sweep is ever wanted, it needs a
// per-title review, not a blanket tag flag.
//
//   npm run flag:adult
'use strict';

const { db } = require('../src/db');

db.pragma('busy_timeout = 10000');

// --- Rule 1: the `hentai` tag — the precise, no-false-positive signal. -------
const ADULT_TAGS = ['hentai'];

const tagPlaceholders = ADULT_TAGS.map(() => '?').join(',');
const flagByTag = db.prepare(
  `UPDATE anime SET is_adult = 1
   WHERE is_adult = 0
     AND id IN (
       SELECT at.anime_id FROM anime_tags at
       JOIN tags t ON t.id = at.tag_id
       WHERE t.name IN (${tagPlaceholders})
     )`
);
const r1 = flagByTag.run(...ADULT_TAGS);

// --- Rule 2: clear-porn OVAs the `hentai` tag missed. ------------------------
// A second band of pornographic OVAs/SPECIALs carries only the `erotica` tag,
// not `hentai` (e.g. the Urotsukidōji / Cream Lemon / "...The Animation" OVAs).
// `erotica` alone is NOT a safe signal — it also sits on mainstream titles
// (Devilman Crybaby, Kuzu no Honkai, To Love-Ru) and on narrative BL/yaoi
// (Saezuru Tori, Gravitation, Ai no Kusabi). So this rule is deliberately
// narrow — it flags an `erotica` title only when ALL of these hold:
//   * format is OVA, SPECIAL or MOVIE — the hentai delivery formats. TV ecchi
//     (Yosuga no Sora, Shuumatsu no Harem) and ONA (Devilman Crybaby) are
//     left alone; mainstream broadcast content stays.
//   * it carries NO boys-love / yaoi / shounen-ai tag — the BL gray zone
//     (explicit but often acclaimed) is left for a separate human call.
//   * it isn't on KEEP — a short allow-list of mainstream / classic
//     exceptions that are erotica-tagged but not pornographic (To Love-Ru &
//     Tsugumomo ecchi OVAs; Haguregumo, a 1866 Tokugawa-era seinen film;
//     STAR Jewel / Yumemiru Chitose, deferred to the BL review).
// NB: this rule also sweeps a cluster of Chinese-language indie films (pinyin
// titles, no anilist_id) that are erotica-tagged and out of the JP-only
// catalog scope — they should ideally be DELETED by a country sweep, but
// flagging is_adult removes them from every surface in the meantime.
const BL_TAGS = ['boys love', 'yaoi', 'shounen ai'];
const KEEP = [
  'To Love-Ru', 'Tsugumomo OVA', 'Nana to Kaoru',
  'Haguregumo', 'STAR Jewel', 'Yumemiru Chitose',
];

const blPlaceholders = BL_TAGS.map(() => '?').join(',');
const keepPlaceholders = KEEP.map(() => '?').join(',');
const flagPornOva = db.prepare(
  `UPDATE anime SET is_adult = 1
   WHERE is_adult = 0
     AND format IN ('OVA', 'SPECIAL', 'MOVIE')
     AND title_romaji NOT IN (${keepPlaceholders})
     AND id IN (
       SELECT at.anime_id FROM anime_tags at
       JOIN tags t ON t.id = at.tag_id WHERE t.name = 'erotica'
     )
     AND id NOT IN (
       SELECT at.anime_id FROM anime_tags at
       JOIN tags t ON t.id = at.tag_id WHERE t.name IN (${blPlaceholders})
     )`
);
const r2 = flagPornOva.run(...KEEP, ...BL_TAGS);

// --- Rule 3: explicit BL/yaoi. -----------------------------------------------
// The BL/yaoi titles Rule 2 deliberately skipped. The line between explicit
// BL pornography and acclaimed-but-explicit BL drama is subjective, so this
// was a human call (user, 2026-06-14): flag EVERY erotica-tagged BL title
// except a short keeplist of the clearly non-explicit, mainstream ones — the
// broadcast TV romances plus Gravitation. This intentionally also flags the
// acclaimed-but-explicit classics (Saezuru Tori, Ai no Kusabi, Zetsuai, Fuyu
// no Semi); they're trivially restorable by adding them to BL_KEEP.
const BL_KEEP = [
  'Junjou Romantica', 'Junjou Romantica 2',
  'Sekaiichi Hatsukoi', 'Sekaiichi Hatsukoi 2',
  'Yami no Matsuei', 'Gravitation: Lyrics of Love',
];
const blKeepPlaceholders = BL_KEEP.map(() => '?').join(',');
const flagBl = db.prepare(
  `UPDATE anime SET is_adult = 1
   WHERE is_adult = 0
     AND title_romaji NOT IN (${blKeepPlaceholders})
     AND id IN (
       SELECT at.anime_id FROM anime_tags at
       JOIN tags t ON t.id = at.tag_id WHERE t.name = 'erotica'
     )
     AND id IN (
       SELECT at.anime_id FROM anime_tags at
       JOIN tags t ON t.id = at.tag_id WHERE t.name IN (${blPlaceholders})
     )`
);
const r3 = flagBl.run(...BL_KEEP, ...BL_TAGS);

// --- Rule 4: tag-less duplicate twins of flagged titles. ---------------------
// The offline-database carries some entries twice (one row per source site).
// The cross-id-less twin gets no tags, so Rules 1-3 (all tag-based) can't see
// it — leaving a tag-less duplicate of an already-flagged adult title still
// visible (caught when a clean "Saezuru Tori" row survived its flagged twin).
// Flag a clean row when an adult row shares BOTH its title AND its year —
// i.e. it's the SAME work. Matching on title alone is unsafe: different anime
// reuse titles (Tezuka's 1968 "Vampire" vs a 2011 hentai OVA; a 1967 "Kage"
// vs a 2004 one; a legit 1991 "Izumo" vs a 2003 hentai), and a year match
// keeps those distinct works apart. NULL years never match, so untagged
// undated rows are left alone.
// Row-value IN (not a correlated EXISTS): SQLite materialises the adult
// (title, year) set once and probes it — O(n), where a correlated subquery
// would full-scan per row (O(n^2)) and hang on a 38K-row table.
const flagTwins = db.prepare(
  `UPDATE anime SET is_adult = 1
   WHERE is_adult = 0
     AND season_year IS NOT NULL
     AND (title_romaji, season_year) IN (
       SELECT title_romaji, season_year FROM anime
       WHERE is_adult = 1 AND season_year IS NOT NULL
     )`
);
const r4 = flagTwins.run();

console.log(
  `flag-adult: ${r1.changes} via [${ADULT_TAGS.join(', ')}], ` +
  `${r2.changes} clear-porn OVA/SPECIAL/MOVIE via erotica (non-BL), ` +
  `${r3.changes} explicit BL/yaoi, ` +
  `${r4.changes} tag-less duplicate twins. ` +
  `Total flagged this run: ${r1.changes + r2.changes + r3.changes + r4.changes}.`
);

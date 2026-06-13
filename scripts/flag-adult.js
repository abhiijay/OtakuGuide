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
//   * format is OVA or SPECIAL — the hentai delivery format. TV ecchi
//     (Yosuga no Sora, Shuumatsu no Harem) and ONA (Devilman Crybaby) are
//     left alone; mainstream broadcast content stays.
//   * it carries NO boys-love / yaoi / shounen-ai tag — the BL gray zone
//     (explicit but often acclaimed) is left for a separate human call.
//   * it isn't on KEEP — a short allow-list of mainstream OVA exceptions.
const BL_TAGS = ['boys love', 'yaoi', 'shounen ai'];
const KEEP = ['To Love-Ru', 'Tsugumomo OVA', 'Nana to Kaoru'];

const blPlaceholders = BL_TAGS.map(() => '?').join(',');
const keepPlaceholders = KEEP.map(() => '?').join(',');
const flagPornOva = db.prepare(
  `UPDATE anime SET is_adult = 1
   WHERE is_adult = 0
     AND format IN ('OVA', 'SPECIAL')
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

console.log(
  `flag-adult: ${r1.changes} via [${ADULT_TAGS.join(', ')}], ` +
  `${r2.changes} clear-porn OVA/SPECIAL via erotica (non-BL). ` +
  `Total flagged this run: ${r1.changes + r2.changes}.`
);

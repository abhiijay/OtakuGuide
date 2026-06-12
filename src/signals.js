// src/signals.js — the canonical twelve-signal list, in display order.
// Single source of truth for BOTH status grids (home page + /how-it-works),
// which drifted apart when statuses lived inline in each view. Update a
// signal's status here the same commit its wiring lands in src/recommender.js.
//
// `blurb` is the short grid text (home page + docs grid). `detail` is the
// longer plain-language explanation rendered only on /how-it-works.
// Copy rule (user, 2026-06-12): simple words, no hyphens in visible text.
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
    name: 'story fingerprint', kanji: '梗概', status: 'live',
    blurb: 'The headline signal. Each summary becomes a list of 384 numbers, so stories match by what they mean, not by the words they use.',
    detail: 'Most anime here carry two summaries: one written by fans on MyAnimeList and one taken from the plot section of Wikipedia. A small language model reads each text and turns it into a list of 384 numbers called an embedding. Think of it as a fingerprint of the meaning. Texts about similar things get similar fingerprints, even when they share no words. When both summaries exist we average the two fingerprints, which paints a rounder picture than either source alone. Two anime are compared by the angle between their fingerprints: the smaller the angle, the closer the stories.',
  },
  {
    name: 'tag rarity', kanji: '札', status: 'live',
    blurb: 'Community tags weighted by how rare they are. A rare tag like "time loop" says far more than a common one like "action".',
    detail: 'Fans label anime with thousands of tags. Sharing a common tag means almost nothing, while sharing a rare and specific one means a lot, so every tag is weighted by how rare it is across the whole catalog. The score for a candidate is the summed weight of the tags it shares with the anime you are viewing. We also keep a list of 49 spelling rules so the four different spellings of science fiction count as one tag instead of four strangers.',
  },
  {
    name: 'genre overlap', kanji: '類', status: 'live',
    blurb: 'Eighteen broad genres. Scores how much two genre lists overlap, built so claiming many genres earns no free boost.',
    detail: 'Genres are the coarse version of tags: action, romance, horror and fifteen more. The score is the size of the overlap between two genre lists divided by the size of everything either list mentions. Dividing that way matters: a show that claims ten genres would otherwise overlap with everything, and this math takes that advantage away. When two candidates tie, the better rated one wins the spot.',
  },
  {
    name: 'studio', kanji: '社', status: 'live',
    blurb: 'Studios have styles you can feel. Sharing a rare studio says a lot. Sharing a giant that made thousands of shows says little.',
    detail: 'Some studios have a look you can spot in seconds. This signal checks which studios made the anime you are viewing, then asks how much of that studio identity each candidate shares. Rarity matters here too: thousands of shows share the biggest studios, so that overlap barely counts, while sharing a small distinctive studio counts heavily.',
  },
  {
    name: 'era', kanji: '時代', status: 'live',
    blurb: 'A nineties classic and a 2020s production feel different. Same year scores full marks, fading to nothing across twenty years.',
    detail: 'Shows from the same era share pacing, humor and visual habits. The score is simple: same year earns full marks, and the score falls in a straight line until it reaches zero at twenty years apart. This signal never finds candidates on its own, because thousands of shows share a year. Instead it nudges the ranking of candidates the other signals already found.',
  },
  {
    name: 'episode count', kanji: '話数', status: 'live',
    blurb: 'A film, a single season and a 500 episode epic ask for very different commitments. Similar lengths score higher.',
    detail: 'Episode counts fall into six buckets: a single film, a handful of episodes, one short season, one full season, a couple of years, and the endless epics. Matching buckets score full marks, neighboring buckets score half, and anything farther apart scores nothing. Like era, this is a nudge on the ranking rather than a way of finding candidates, since too many shows share a bucket for it to point anywhere on its own.',
  },
  {
    name: 'source material', kanji: '原作', status: 'live',
    blurb: 'Stories born as manga, novels, games or originals each have their own DNA. Coverage grows as a crawl fills the data in overnight.',
    detail: 'A show adapted from manga inherits manga habits: chapter rhythms, cliffhangers, visual framing. Novel adaptations narrate more. Originals take more risks with endings. An exact match on the source scores full marks and members of the same family score half, so two kinds of novels still count for something. For titles where we have not fetched this data yet, the signal stays silent rather than guessing, and it wakes up on its own as the data lands.',
  },
  {
    name: 'format', kanji: '形式', status: 'live',
    blurb: 'TV series, movie, OVA, ONA or special. An exact match scores full marks and close cousins score half.',
    detail: 'The format hints at what kind of watch a title is: a movie is one evening, a TV series is a season of evenings, a special is dessert. Exact matches score full marks. TV and ONA are treated as cousins because modern streaming shows blur that line, and the same goes for OVA and special. Everything else scores nothing. This one also works as a ranking nudge rather than a finder.',
  },
  {
    name: 'character fingerprints', kanji: '人物', status: 'v2',
    blurb: 'Find anime with characters like the ones you love. Needs one extra fetch per anime, so it waits for version two.',
    detail: 'The plan: fingerprint the descriptions of the main cast the same way we fingerprint summaries, so you could search by the kind of people a story follows. The catalog data we import does not include characters, and fetching them means one extra request for every anime in the catalog, which is many hours of polite crawling. It waits for version two.',
  },
  {
    name: 'review fingerprints', kanji: '批評', status: 'v2',
    blurb: 'What reviewers praise captures humor and tone that summaries miss. Waits for version two.',
    detail: 'A summary tells you the plot. Reviews tell you whether the jokes land, whether the animation carries the fights, whether the ending pays off. Fingerprinting review text would capture tone and vibe without any extra machinery. Same story as characters: it needs a separate fetch per anime, so it waits for version two.',
  },
  {
    name: 'popularity pass', kanji: '人気', status: 'waits: users',
    blurb: 'Never part of similarity. Applied afterwards as a quality floor plus a small boost for hidden gems. Needs user data first.',
    detail: 'Popularity never decides similarity, because that road leads to every list showing the same famous twenty shows. Instead it will run after the ranking: a quality floor to keep broken titles out, and a gentle boost for great shows few people have seen, so the list can still surprise you. Tuning that fairly needs real watch data from real users, which does not exist yet.',
  },
  {
    name: 'relations filter', kanji: '関係', status: 'live',
    blurb: 'Keeps a franchise out of its own list. Sequels, films and specials of the show you are viewing never appear as recommendations.',
    detail: 'Nobody needs to hear that a show is similar to its own sequel. Before ranking, we walk the relation graph outward from the anime you are viewing, up to three steps, and remove everything it reaches from the candidate pool. The catalog also holds some entries twice under the same name, so we additionally remove candidates whose title matches, or begins the same way as, any title in the franchise. The franchise itself still appears on the page in its own relations section, where it belongs. Once watch histories exist, discover mode will also skip sequels of shows you have already seen.',
  },
];

module.exports = { SIGNALS };

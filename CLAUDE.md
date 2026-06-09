# CLAUDE.md — Context for AI Assistants

This file is auto-loaded by Claude Code at the start of every conversation
in this project. Read it carefully before suggesting changes.

## What this project is

OtakuGuide is a minimalist anime tracker and recommender. It is a deliberate
rebuild of a vibe-coded project that ended up incomprehensible to its author.
The point of this rebuild is **understandability** as much as it is features.

The original project lives at `/Users/homebase/Projects/ALTIER/Anime-Recommender`.
It is *reference material only* — useful for the working auth middleware, the
Jikan image-fetch logic, and the `user_preferences` schema spine. **Do not
import wholesale.**

## Current state (last updated 2026-06-10, post-pivot)

**Scaffold + database + AniList client (now repurposed) + embeddings are live.** Express+EJS+Tailwind boots cleanly; 15-table SQLite schema reflects post-pivot shape (split synopsis columns, simplified tags). `src/anilist.js` retained for long-tail synopsis fallback; primary catalog/synopsis pipeline (offline-database + Jikan + Wikipedia) is next to build.

**Repository:** https://github.com/abhiijay/OtakuGuide (public, branch `main`).

Files on disk:
- `README.md`, `CLAUDE.md` — documentation
- `package.json` — deps: express, ejs, dotenv, **better-sqlite3, sqlite-vec** (prod) + tailwindcss, nodemon, concurrently (dev). Seven npm scripts.
- `.env.example`, `.gitignore`
- `server.js` — boots Express, serves static files, renders `home.ejs` at `/`
- `tailwind.config.js` — defines `sakura` (`#DC143C`), `ink`, `paper` colors + Shippori Mincho font stack
- `styles/input.css` — 3-line Tailwind source
- `views/home.ejs` — smoke-test page
- `public/css/styles.css` — compiled Tailwind output (gitignored)
- `db/schema.sql` — all 15 tables, 103 columns, fully commented; 5 groups (auth / catalog / lookups+joins / relationships / user behavior)
- `db/otakuguide.sqlite` — initialized empty database file (gitignored)
- `scripts/init-db.js` — runs `schema.sql` against `db/otakuguide.sqlite` (idempotent)
- `src/db.js` — single SQLite connection; `foreign_keys=ON`, `journal_mode=WAL`, `sqlite-vec` loaded
- `src/anilist.js` — AniList GraphQL client. Exports `fetchHighestAnimeId()` and `fetchAnimeBatchByIds(ids)`. ID-enumeration strategy (not Page-based). 2200ms rate limiter. Smoke test included (`node src/anilist.js`).
- **`src/embeddings.js`** — `Xenova/all-MiniLM-L6-v2` wrapper. Exports `embed(text)` returning a 1536-byte Float32 Buffer. Lazy-loads the model on first call (~80MB download). Smoke test included (`node src/embeddings.js`).

No auth, no API routes, no real views, no anime data yet. Catalog import is the next step.

## Where we left off (2026-06-10, post-pivot)

**Architecture pivoted, pre-flight clean, ready to write the new importer.**

What changed today after the pivot:
- Catalog source pivoted from AniList scraping to `anime-offline-database` + Jikan (synopsis) + Wikipedia (supplemental synopsis). See "Architecture pivot" decision in the log below.
- Schema simplified: `anime.synopsis` split into `synopsis_mal` + `synopsis_wiki`; `anime_tags.rank` + spoiler flags dropped; `tags.description` + `category` dropped.
- DB re-initialized against the updated schema. Round-trip test re-run, still passes.
- `src/anilist.js` retained for long-tail synopsis fallback; not in the main import path anymore.

Earlier today (before the pivot):
- `src/anilist.js` was built and tested as a full-catalog crawler — ID enumeration, 27 req/min throttle, retries. Now repurposed.
- `src/embeddings.js` wraps `Xenova/all-MiniLM-L6-v2`. Returns a 1536-byte Float32 Buffer (matches the schema CHECK constraint). First call downloads ~80MB into `node_modules/@xenova/transformers/.cache/`; subsequent calls reuse. Smoke test sanity check: similar synopses score 0.49 cosine similarity, unrelated ones 0.11.
- `scripts/test-round-trip.js` wires anilist + embeddings + db end-to-end for one anime, ROLLBACKs. Passes against the new schema (verified 2026-06-10).

**Numbers from the smoke test:**
- Highest AniList anime id: **213,068**
- ID batches at 50 per request: **~4,262 requests** to cover the full ID space
- At ~27 req/min (degraded rate limit): **~158 min (~2.6 hours)** of pure API time
- Hit rate is low in mid-range (a 100k-slice returned 3/50) — most IDs are manga, non-JP, deleted, or adult. The actual Japanese-anime catalog will be in the tens of thousands, not 213k.
- Field coverage on real anime: **100% on every critical column**. Minor expected nulls: 88% English title (some have none), 91% banner image (some lack banner), 97% episodes (ongoing series), 97% relations/recommendations (standalone niche titles).

## Earlier — schema phase (2026-06-09)

Schema phase **complete**. All 15 tables written, validated (CHECK constraints fire correctly, FK cascades work end-to-end), initialized on disk, and pushed to GitHub.

Decisions closed today:
- **`users.show_adult`** — no column. Adult content (AniList `isAdult` flag, hentai only) is filtered globally at the query layer in `src/db.js`. Gore/violence anime (Dorohedoro, Chainsaw Man, Berserk, Devilman Crybaby) all stay — they're NOT flagged as adult.
- **`mean_score` → `average_score`** — switched to AniList's weighted score (better for ranking; small-sample anime don't get artificial boosts).
- **`country_of_origin`** — not stored as a column. v1 filters to Japan-only at **import time**. When we later expand to donghua (Solo Leveling, Throne of Seal, Renegade Immortal) and Korean aeni, we'll add the column then.
- **Borderline columns** — kept `duration_minutes` and `season` (useful filters), kept `notes`/`started_at`/`finished_at` on `user_anime` (standard tracker fields), dropped `favorites`.
- **No `system_metadata` table** — for v1, hardcode model version as a constant; add a real ops table later.
- **`updated_at` exception on `user_anime`** — it gets mutated constantly, sorting "recently updated" is a v1 feature, writes will be centralized through a helper in `src/db.js`.

Tables (final): users, external_accounts, anime, genres, tags, studios, characters, anime_genres, anime_tags, anime_studios, anime_characters, relations, community_recommendations, user_anime, user_vectors.

Captured feature idea: **character search** ("search Sasuke → show Naruto") works on the existing schema with zero changes — `WHERE c.name LIKE '?' JOIN anime_characters JOIN anime`, ordered by role rank (MAIN > SUPPORTING > BACKGROUND). Will be wired up when we build the search endpoint.

## Next move

Build order from here (post-pivot):
1. ~~`src/anilist.js`~~ **Done; repurposed for on-demand long-tail fallback.**
2. ~~`src/embeddings.js`~~ **Done 2026-06-10.** `Xenova/all-MiniLM-L6-v2` wrapper.
3. **`src/offline-db.js`** — downloads `anime-offline-database-minified.json` to `db/anime-offline-database.json`, parses entries, yields normalized records. ~50 lines.
4. **`src/jikan.js`** — `fetchSynopsis(mal_id)` + `fetchThemesDemographics(mal_id)`. 2 req/sec, retry on 429. Strip MAL attribution patterns. ~60 lines.
5. **`src/wiki.js`** — `fetchPlotSection(title)`. Two-step: sections list → plot section text. 5 req/sec polite. Polite `User-Agent`. ~50 lines.
6. **`scripts/import-anime.js`** — orchestrator:
   - Phase 1: load offline-DB → upsert anime rows, genres/tags/studios + their joins
   - Phase 2: per anime, fetch Jikan synopsis + themes/demographics + Wikipedia plot in parallel (limited concurrency)
   - Phase 3: embed Jikan synopsis + Wikipedia plot per anime, average vectors, write `synopsis_vec`
   - Phase 4: second pass for relations (from offline-DB's `relatedAnime`)
   - Resumable via `db/import-progress.json` checkpoint.
7. **Run the import** — overnight, ~8 hours total. Wake to a populated database.
8. Then: `src/recommender.js` → auth → routes → views.

Next coding step is `src/offline-db.js`.

## When picking back up — concrete next step

If you're returning after time away, do this in order:

1. **Re-read this whole file.** Skim the README too. Do not try to remember decisions from memory.
2. **Confirm or revise the open decisions** in the "Open decisions" section below. Anything that has changed in your thinking, update here first.
3. ~~First code to write is the file scaffold.~~ **Done 2026-06-07.** Scaffold exists, `npm run dev` boots cleanly.
4. ~~Next up: the database.~~ **Done 2026-06-09.** Schema written, validated, on disk; `src/db.js` opens it with `sqlite-vec` loaded.
5. ~~Next up: AniList client.~~ **Done 2026-06-10.** `src/anilist.js` enumerates the catalog via `id_in` batching; smoke test passes.
6. **Next up: embedding pipeline** (`src/embeddings.js`), then catalog import (`scripts/import-anime.js`). See "Next move" above.
7. **After that, in order:** recommender engine → auth → AniList OAuth flow → JSON API → views. Don't reorder.

## Decisions log (with reasoning)

This is the authoritative list of locked-in choices and *why*. If you want to revise a decision, update the reasoning here first, then propagate.

### Greenfield rebuild
**Decision:** Start fresh at `/Users/homebase/Projects/OtakuGuide`. Old project remains at `/Users/homebase/Projects/ALTIER/Anime-Recommender` as reference only.
**Why:** Old project had ~30 broken or dead items (forge-able session secret, fake password reset, double-defined functions, dead tables, CDN Tailwind, global grayscale CSS hack, etc.). Rewriting in place was estimated as more work than starting fresh, and wouldn't teach the structure. User has 2 months and learning is part of the goal.

### Stack: Node + Express + EJS + Tailwind + SQLite
**Decision:** Same family as the old project.
**Why:** Boring is the point — the user must be able to read every line. EJS is just templating, not a bottleneck. Express is mature. Tailwind compiles to one small CSS file. SQLite needs no server. No SPA framework — not needed for this UI.

### Database: SQLite via `better-sqlite3` + `sqlite-vec` extension
**Decision:** SQLite stays. Add `sqlite-vec` extension for vector queries.
**Why:** At ~30K anime, vector math is sub-millisecond on a single CPU — a dedicated vector DB (Pinecone, Chroma, Qdrant) is overkill. `sqlite-vec` gives proper vector queries (`ORDER BY embedding <-> ?`) in plain SQL, in the same file, with no extra server. Migration path to Postgres + pgvector remains clean if the project ever ships publicly.

### Streaming sync: AniList OAuth only
**Decision:** No Crunchyroll or Netflix integration.
**Why:** Neither has a public consumer API for watch history. Reverse-engineered Crunchyroll endpoints break monthly and risk ToS violations. AniList has a stable, documented GraphQL API and many anime fans already maintain their lists there.

### Auth: Email/password + AniList OAuth (AniList is OPTIONAL)
**Decision:** Both methods supported. AniList doubles as both social login and sync source. **AniList is never required.**
**Why:** Two distinct uses of AniList must be kept separate:
1. **AniList as our catalog source** (background, invisible to users) — we bulk-import anime metadata from AniList's public GraphQL once, store locally. Users don't need AniList accounts for us to do this.
2. **AniList OAuth as one login option** (user-facing, optional) — users *can* connect AniList for login + watch-list sync, but it's not a gate. Email/password is the equal default.

**The full UX for non-AniList users must work:** sign up with email → onboarding quiz ("pick 5 anime you've loved") → browse/track/rate inside OtakuGuide → recommender works from local activity. AniList sync is a *convenience for people who already have a list there*, not a prerequisite.

**Risk to watch:** sign-up and onboarding UI must present email and AniList as equal-weight options. If the AniList button is bigger or louder, we've effectively gated the app even though we didn't intend to. Marketing copy must avoid framing OtakuGuide as "an AniList client."

### Recommendation engine: Embeddings as the core, not collab-only
**Decision:** Start at the sentence-embedding level (Level 4 in the survey), not just content/collab (Levels 2-3).
**Why:** Embeddings work cold-start (no community needed); they're more sophisticated by default. The math is simpler than matrix factorization. User explicitly wanted ML and NLP-based similarity. Collaborative filtering still runs as one signal among many, not the spine.

### Embedding model: `Xenova/all-MiniLM-L6-v2` running locally in Node
**Decision:** Local model, not OpenAI API.
**Why:** Free, no API keys, ~80MB one-time download. 384-dimensional vectors. Quality is well-documented and good enough for similarity matching at our scale. No external dependency that can change pricing or go down.

### Title not in synopsis embedding
**Decision:** Embed synopsis + genres + tags. Title stays in the database for search/display only, not for similarity math.
**Why:** Stylized romanizations ("Shingeki no Kyojin") and franchise names ("Re:Zero kara Hajimeru Isekai Seikatsu") are mostly noise. Some titles are descriptive but the synopsis already covers it. The embedding model is robust enough to weight informative tokens, but cleaner inputs produce cleaner vectors. User instinct, confirmed.

### Faceted vectors, not one combined vector
**Decision:** Each anime gets multiple vectors stored as separate columns (synopsis, characters, reviews, tags). Plus categorical/numerical columns for studio, era, format, etc.
**Why:** Enables faceted UI weighting — sliders for "similar story / similar characters / similar tone." Production-quality systems (Spotify, Netflix) do this. Power-user gold. Marginal complexity cost over single-vector.

### 12 signals in v1, no staging across versions
**Decision:** All 12 signals ship in v1, plus 9 recommender-theory features. No "we'll add it later" for the core recommender.
**Why:** User explicitly: "I don't want to keep any gaps just because it's a side project." Building all signals at the start is also less total work than retrofitting one at a time.

### Visual aesthetic: Sakura red + Japanese sumi-e
**Decision:** Black/white minimalism + a single sakura red accent (vermillion, target `#DC143C`–`#E03C42`) + ink-painting motifs, paper backgrounds, optional kanji watermarks.
**Why:** User's stated vision. Kenmei-inspired (clean tracker UI), not a Kenmei clone. The direction is **open to evolution** — if the user shares new inspiration, update the Aesthetic section here rather than treating the original as locked.

### Tailwind: compiled locally, no CDN
**Decision:** Build step compiles `styles/input.css` → `public/css/styles.css`. Wire into `npm start` and `npm run dev`.
**Why:** The old project shipped the entire Tailwind JIT compiler to every page via CDN. Slow. Then they hacked it with `* { filter: grayscale(1) !important }` to force the minimalist look, which destroyed the design system. Compiled output is one small cacheable file and the design system stays intact.

### Flat `src/` — no `models/` / `controllers/` / `services/`
**Decision:** All source code lives directly in `src/`, with one subfolder for routes.
**Why:** For ~25 files total, folder ceremony adds friction without organizational benefit. The user is learning — fewer indirections = more readable.

### One URL per action — no aliases
**Decision:** No `/login` + `/signin` aliases. No `/register` + `/signup` aliases.
**Why:** The old project had this and it doubled the URL space for no benefit.

### AniList catalog enumeration: ID-batching, not Page-based pagination
**Decision:** `src/anilist.js` walks the AniList ID space `1..highestId` in batches of 50 via `id_in: [...]`. No `Page(page: N)` deep pagination.
**Why:** AniList enforces a hard **5000-entry depth cap** on `Page` queries (`page * perPage <= 5000`). It's undocumented but real. Worse, `pageInfo.total` and `pageInfo.lastPage` are **officially broken** per AniList's own docs at docs.anilist.co/guide/graphql/pagination — only `hasNextPage` is reliable. A full-catalog crawl via Page is therefore impossible. The canonical workaround, used by manami-project/modb-app (the aggregator behind anime-offline-database), is ID enumeration: every request stays at Page depth 1, the 5000 cap never fires, and we sidestep the broken `total` field entirely. We use `id_in: [50 ids]` to batch 50 IDs per request, which is 50× faster than manami's one-ID-per-request Kotlin implementation.

**Mechanics:**
1. `fetchHighestAnimeId()` — one query: `Page(perPage: 1) { media(type: ANIME, sort: ID_DESC) { id } }` returns the largest live ID.
2. `fetchAnimeBatchByIds([1..50, 51..100, ...])` — fetches batches of 50.
3. Standing filters baked into the query: `type: ANIME`, `countryOfOrigin: "JP"`, `isAdult: false`. IDs that fail these filters (manga, non-JP, hentai), as well as deleted IDs, are silently absent from the response. Caller diffs requested vs returned IDs to record "skip" entries.
4. The import script will persist a `skip_ids.json` checkpoint so resumed crawls don't re-fetch known-empty IDs.

### Architecture pivot 2026-06-10: catalog via offline-database, synopses via Jikan + Wikipedia
**Decision:** Stop scraping AniList for bulk catalog/synopsis. New pipeline:
1. **Catalog skeleton** from `manami-project/anime-offline-database` — one weekly-refreshed JSON, no API calls. Gives us every anime entry plus cross-IDs (MAL/AniList/Kitsu/AniDB) and aggregated tags.
2. **Primary synopsis** from MAL via Jikan (`api.jikan.moe/v4/anime/{mal_id}`) — empirically the longest, most detailed fan-prose source. 2 req/sec, no auth.
3. **Supplemental synopsis** from Wikipedia Plot section — `en.wikipedia.org/w/api.php` two-step (sections list → section text). 5 req/sec parallel, no auth.
4. **Long-tail fallback** to AniList on-demand only — when a user views an anime for which we have no synopsis. One-off "client" use, defensible per TOS.

**Why:**
- **AniList TOS explicitly forbids bulk collection.** Their terms-of-use file at `AniList/docs/docs/guide/terms-of-use.md` prohibits hoarding, mass collection, and use within competing tracker services. OtakuGuide-as-originally-scoped hit all three landmines and risked an IP ban at any time.
- **Empirical synopsis comparison (2026-06-10):** Wikipedia plot sections are genuinely stylistically distinct from MAL (encyclopedic vs fan-prose), often longer (2-8K chars vs MAL's 1K). Kitsu turned out to be near-verbatim copies of MAL — dropped from the plan. Tatami Galaxy demonstrated the point cleanly: MAL describes the inciting scene, Wikipedia explains the parallel-universe device, ANN names the supporting cast — three different perspectives on the same anime.
- **Multi-source embedding averaging** (signal #1's new shape): embed MAL synopsis → vector A; embed Wikipedia plot → vector B; store the mean. Richer composite than any single source, no truncation loss.
- **Cross-IDs come free** with the offline-database download — every entry has MAL/AniList/Kitsu/AniDB IDs, so multi-source resilience is baked in without extra work.

**Time budget:** offline-DB download (~1 min) + Jikan synopses (~5 hr) + Wikipedia plots (~3.5 hr in parallel) + embeddings on CPU (a few hr). One overnight job, fully legal.

### Signal table revisions (locked 2026-06-10)
Some signals from the original 12-signal v1 list are deferred to v2 because the offline-database + Jikan path doesn't carry them cheaply:
- **Signal #9 — character vectors:** offline-database doesn't include characters. Jikan exposes characters via a SEPARATE call (`/v4/anime/{id}/characters`), adding ~4 hours to import. Deferred to v2. The `characters` + `anime_characters` tables stay in the schema, just empty in v1.
- **Community-curated recommendations** (originally an additional signal): same story — Jikan's `/v4/anime/{id}/recommendations` is a separate call, ~5 hours. Deferred. `community_recommendations` table stays empty in v1.
- **Signal #12 relations:** offline-database has a `relatedAnime` field but doesn't categorize the relation type (sequel/prequel/spin-off/etc.). For v1 every relation is stored with `relation_type = 'RELATED'`. The franchise-duplicate filter still works (any related anime is excluded from discover); it's just blunter than the AniList-categorized version. Categorized relations come back in v2 if we add Jikan's `/relations` call.

This breaks the original "12 signals in v1, no gaps" pledge. The reason is the AniList TOS pivot — the cost shifted from "everything included" to "everything except character + recs requires separate paid API calls each ~5 hours." The user agreed to the trade-off on 2026-06-10.

### Schema simplifications from the pivot (locked 2026-06-10)
- **`anime.synopsis` split** → `synopsis_mal` + `synopsis_wiki`. Both raw texts stored so we can re-embed if we change models without re-fetching.
- **`anime_tags.rank` and spoiler flags dropped** — no source provides these. TF-IDF weights are computed at query time from catalog frequency.
- **`tags.description` and `tags.category` dropped** — no source provides these without AniList.

### Pre-flight known issues for `scripts/import-anime.js` (locked 2026-06-10)
**Decision:** The importer must handle these explicitly. All were caught by `scripts/test-round-trip.js` before writing the importer.
1. **FK constraint on `relations` and `community_recommendations` requires both anime to be in our catalog.** When importing anime A that points to anime B, B may not exist yet. The importer runs in two phases: (a) insert all anime + their lookup/join rows; (b) insert relations + community_recommendations, filtering to pairs where both AniList ids are present.
2. **Strip HTML before embedding.** AniList descriptions contain `<br>`, `<i>`, etc. Without stripping, the embedding vector is ~7% noisier. Storage keeps the HTML (display layer sanitizes); only the input to `embed()` gets stripped.
3. **Embedding model is English-only.** `Xenova/all-MiniLM-L6-v2` produces near-random vectors for non-English text (Japanese ↔ English equivalent: cosine 0.003). For v1 this is acceptable because AniList descriptions are English by default; obscure entries with only-Japanese descriptions will get noisy vectors. If we ever need real multilingual support, swap the `MODEL_ID` in `src/embeddings.js` to `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (one-line change).
4. **INSERT OR IGNORE pattern for all lookup tables** (genres, tags, studios, characters). Round-trip test confirmed it handles repeated rows cleanly.
5. **Embedding edge cases:** `embed()` rejects empty/null input; importer must skip anime with null synopsis or fall back to title.

### Accepting protobufjs CVEs in @xenova/transformers
**Decision:** Live with the 4 protobufjs vulnerabilities (3 high, 1 critical) flagged by `npm audit` for v1. Do not run `npm audit fix --force`.
**Why:** The CVEs are in a deep transitive dep: `@xenova/transformers` → `onnxruntime-web` → `onnx-proto` → `protobufjs`. All of them require attacker-controlled protobuf input to exploit. We pass the embedder strings (anime synopses from AniList, which we already trust as our catalog source) and load Xenova-published model files from HuggingFace's CDN. There is no path for malicious protobuf to reach our code. `npm audit fix --force` would downgrade `@xenova/transformers` to 2.0.1 (breaking change, older model loader). Revisit when upstream releases a clean version.

### AniList rate limit: 27 req/min, not 90
**Decision:** Throttle `src/anilist.js` to 1 request per 2200ms (~27 req/min) instead of the 800ms (~75/min) we initially planned.
**Why:** AniList's documented limit is 90/min, but their docs at docs.anilist.co/guide/rate-limiting state the API is currently in a **degraded state and officially limited to 30/min** until full restoration. Tripping the degraded limit risks IP blocks. We target ~27/min (10% under 30) to leave headroom for retries. When AniList restores the 90/min limit, drop `MIN_INTERVAL_MS` from 2200 to 700.

### Adult content: filtered globally, no user toggle
**Decision:** Every catalog query excludes titles where AniList's `isAdult` flag is true. No `users.show_adult` column, no settings toggle. Filter centralized in `src/db.js`.
**Why:** AniList's `isAdult` flag specifically marks explicit sexual content (hentai), not gore or violence. So dark / violent / disturbing seinen (Dorohedoro, Chainsaw Man, Berserk, Devilman Crybaby, Hellsing, Attack on Titan) all stay in the catalog. The filter cleanly removes what shouldn't be in a general-purpose tracker without sacrificing any of the user's actual taste range. One less setting to design, one less column on `users`, one less query branch.

### Fail loud on missing config
**Decision:** Crash on startup if `SESSION_SECRET` or other required env vars are missing.
**Why:** The old project silently fell back to a hardcoded default ("otaku-guide-secret-key"), creating a forge-able session cookie vulnerability. Crashing makes the problem visible.

## Open decisions (revisit when picking back up)

These have not yet been locked. Confirm or revise before writing the relevant code:

1. ~~Dark mode in v1 or v2?~~ **Decided 2026-06-06: deferred. Add later only if needed.**
2. ~~Font choice.~~ **Decided 2026-06-06: Shippori Mincho, self-hosted.**
3. **Final sakura red hex value.** Range is `#DC143C`–`#E03C42`. Pick the exact value when writing CSS; sample from the inspiration enso image if helpful.
4. **AniList OAuth credentials.** User must register an app at https://anilist.co/settings/developer and provide `client_id`, `client_secret`, `redirect_uri`. These go in `.env`. (Active — user starting this now.)
5. ~~First-run catalog import strategy.~~ **Decided 2026-06-10:** ID-enumeration via `id_in` batches of 50, walking 1..213,068. ~158 min API time at degraded 27 req/min. Two-phase: metadata first (resumable via `skip_ids.json` + `last_id_processed.json` checkpoint), embeddings second. See "AniList catalog enumeration" decision-log entry.
6. **AniList API field shape for import (what we ask per anime).** ~~To confirm at start of next session.~~ **Decided 2026-06-10:** see the `ANIME_BATCH_QUERY` constant in `src/anilist.js` — every field documented and mapped to a schema column.
7. **Build order (locked 2026-06-06):** backend first, frontend later. No rushing. The recommender engine, catalog import, schema, and API surface get done before any view files exist beyond a placeholder.

## Hard rules

- **No vibe-coding.** Every new function, route, or table must have a purpose
  the user can articulate in one sentence. If you're tempted to add "just in
  case" code, don't.
- **No CDN for Tailwind.** Compile locally to `public/css/styles.css`.
- **No global CSS hacks.** Especially nothing like
  `* { filter: grayscale(1) !important }` (which is how the old project
  destroyed its design system).
- **No dead columns or dead tables.** A column gets added the same commit it's first used.
- **No route aliases.** One URL per action — never `/login` and `/signin`
  pointing to the same handler.
- **Async consistency.** All DB calls go through `better-sqlite3`'s sync API.
  No mixing sync and async patterns inside the model layer.
- **Fail loud on missing config.** If `SESSION_SECRET` isn't set, crash on
  startup. Do not silently fall back to a default.
- **No fake features.** No password-reset buttons that don't send emails.
  No admin checks for users that can never exist. Either build it or omit it.
- **No throwaway scripts in `scripts/`.** Every script earns a slot in
  `package.json` and gets a one-line comment at the top explaining when to run it.

## Aesthetic

- Black and white minimalism with **sakura red** (vermillion, target
  `#DC143C`–`#E03C42`) as the single accent.
- Japanese sumi-e ink-painting inspiration: paper backgrounds, ink-brush
  motifs, optional kanji watermarks (桜 / アニメ).
- **Logo: an enso** — the single-stroke Japanese ink-brush circle, in sakura
  red and black, no text. Reference image: `~/.claude/image-cache/2e05b1a9-d7ce-4941-9ea3-6e24dc68fb09/2.png`.
- **Emotional tone: passion.** Channels the fire of anime antagonists like
  Taiga Kagami (Kuroko no Basket), Bakugo, Asta. Quiet Japanese frame
  containing intense energy. Not soft, not delicate — committed.
- Kenmei-inspired, **not** a Kenmei copy.
- Nav tabs are black/white in repose, sakura red on hover/active.
- **Typography (locked): Shippori Mincho** (self-hosted via `public/fonts/`)
  for headings, system sans for body.
- **Dark mode deferred.** v1 ships light theme only; add later if a real need
  surfaces.

The aesthetic direction is **open to evolution**. When the user shares new
inspiration, update this section rather than treating the original as locked in.

## Architecture

- Flat `src/` — no `models/`, `controllers/`, or `services/` folders for a
  project this size.
- Three route files split by what they return: `pages.js` (HTML),
  `api.js` (JSON), `auth.js` (login/logout/AniList callback).
- Routes call helpers in `src/db.js`, `src/auth.js`, `src/anilist.js`,
  `src/recommender.js`. No deeper indirection.

## Data sourcing & resilience

(Architecture pivoted 2026-06-10 — see "Architecture pivot" decision in the log above for the full why.)

### Primary catalog source: anime-offline-database (manami-project)

`https://github.com/manami-project/anime-offline-database` — a community-aggregated JSON snapshot combining MAL + AniList + Kitsu + AniDB + Notify.moe, refreshed weekly. We download one minified JSON file (~30K entries) at import time. Gives us:

- Every Japanese anime (we filter to `type: TV/MOVIE/OVA/ONA/SPECIAL` and `JAPAN`)
- Titles, year, episodes, format, status, score, image URLs
- Cross-IDs to MAL, AniList, Kitsu, AniDB (the `sources` array)
- Aggregated tags (deduplicated across all source databases — no per-source rank)
- Studio + producer names
- `relatedAnime` URLs (for the relations table, but without categorized relation_type)

No API calls. No rate limit. Legal use (the project explicitly publishes the dataset for redistribution).

### Primary synopsis source: MAL via Jikan

`https://api.jikan.moe/v4/anime/{mal_id}` — Jikan is the unofficial MAL REST API. 2 req/sec safe, no auth. We use the `mal_id` from the offline-database to look up each anime's synopsis. Empirical comparison (2026-06-10) showed Jikan synopses are consistently the longest and most detailed fan-prose available (averaging ~1000 chars, frequently 1500-2000 for popular anime).

Jikan also returns themes + demographics in the same call — bonus tag-axis data, populated into our `tags` + `anime_tags` tables alongside the offline-DB tags.

Strip trailing `[Written by MAL Rewrite]` / `(Source: ANN)` patterns before storing.

### Supplemental synopsis source: Wikipedia Plot section

`https://en.wikipedia.org/w/api.php` — two-step (sections list → plot section text). 5 req/sec polite limit, no auth, just a descriptive `User-Agent`. CC BY-SA license requires footer attribution.

Empirically distinct from Jikan: encyclopedic style, focuses on plot structure rather than mood/character intros, often 2-8K chars (much longer than MAL on mainstream titles). Tatami Galaxy demo: MAL describes the inciting scene, Wikipedia explains the parallel-universe device — different angles on the same anime.

Coverage on test set: 8/8 (will degrade on obscure titles — fall back to Jikan-only when Wikipedia has no plot section).

### Synopsis embedding (the new shape of signal #1)

For each anime:
1. Embed Jikan synopsis → vector A
2. Embed Wikipedia plot → vector B (if present)
3. Store `synopsis_vec = mean(A, B)` (or just A if B is missing)
4. Keep both raw texts (`synopsis_mal`, `synopsis_wiki`) so re-embedding under a new model doesn't require re-fetching.

### Long-tail fallback: AniList on-demand

When a user views an anime for which we have no synopsis (both Jikan and Wikipedia missed), `src/anilist.js` fetches it once on-demand and caches. This is "client" use, not bulk collection — fully within AniList's TOS.

### Schema implications (v1)

- `anime` table has `anilist_id`, `mal_id`, plus we'll add provenance fields if needed in v2. Both nullable — anime missing from MAL or AniList stay in the catalog with whatever cross-IDs they do have.
- The offline-database download lives at `db/anime-offline-database.json` (gitignored — it's ~10 MB and refreshed independently).
- `external_accounts` table supports multiple providers (`provider: 'anilist' | 'mal' | ...`) — supports future OAuth providers without migration.

### Resilience guarantees

If any single source disappears tomorrow:
- **Offline-database goes dark:** we have the last JSON download cached locally; new entries miss until restored. App keeps working on existing catalog.
- **Jikan goes dark:** synopses can be re-imported from Kitsu (~80% coverage) or AniList (small-scale on-demand). App keeps working on cached embeddings.
- **Wikipedia goes dark:** signal #1 falls back to single-source (Jikan-only embedding). Recommendations slightly less rich but functional.
- **AniList goes dark:** we lose user-list sync only; OtakuGuide's catalog and recommender are not affected.
- **User data is safe.** Lists, ratings, progress, favorites all live in our SQLite, not any third party's.

What we'd lose by losing AniList specifically: live sync of progress between OtakuGuide and a user's external AniList account (cosmetic — local data is intact).

## Database

- SQLite via `better-sqlite3` (sync API — single threaded reads/writes,
  no callback/Promise mess).
- **Vector queries via the `sqlite-vec` extension** — proper cosine-similarity
  search in plain SQL: `SELECT title FROM anime ORDER BY embedding <-> ? LIMIT 10`.
  Avoids a separate vector database while keeping vector-native ergonomics.
- Schema lives in `db/schema.sql`, plain SQL with comments on every column.
- Five tables tentatively: `users`, `anime`, `user_anime`, `external_accounts`, `sessions`.
- If we ever outgrow SQLite, the migration target is Postgres + pgvector.
  Don't write code that depends on SQLite-specific extensions *other than*
  `sqlite-vec` (which maps cleanly to pgvector syntax).

## Recommendation engine

The project owner has explicitly committed to building this without gaps.
"Side project" is not an excuse to ship a thin recommender — depth is the goal.

### Embedding model

- `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers`. Runs in Node.js,
  no API key, no cost, ~80MB one-time download. 384-dimensional vectors.

### Signal inventory — what goes into the recommender

**v1 (shipping at launch — twelve signals):**

| # | Signal | Form | Source | Why it's in |
| --- | --- | --- | --- | --- |
| 1 | Synopsis embedding | 384-d vector | AniList `description` | Captures plot/tone/themes by meaning, not tags. The headline signal. |
| 2 | AniList tags | TF-IDF vector | AniList `tags` | Community-curated, granular ("Iyashikei," "Slow," "Surreal Comedy"). Rare tags weighted higher. |
| 3 | Genre | One-hot vector | AniList `genres` | Classic categorical. Coarser than tags but cleaner; weight independently. |
| 4 | Studio | Categorical embedding | AniList `studios` | Strong style signal. ufotable / KyoAni / MAPPA each cluster recognizably. |
| 5 | Year / era | Numerical + bucketed | AniList `seasonYear` | 90s vs 2020s anime differ structurally. Some users have era preferences. |
| 6 | Episode count buckets | Categorical | AniList `episodes` | Short / medium / long / movie. Pacing implication. |
| 7 | Source material | Categorical | AniList `source` | Manga / LN / original / game adaptations have different DNA. |
| 8 | Format | Categorical | AniList `format` | TV / Movie / OVA / Special / ONA. Different commitments. |
| 9 | Character vectors | 384-d vector (avg of main cast) | AniList characters | "Find anime with characters like Naruto." |
| 10 | Review-aggregate vector | 384-d vector | AniList reviews | Captures humor / tone / animation discourse without an LLM. |
| 11 | Mean score & popularity | Numerical (re-ranking only) | AniList scores | NOT in the similarity vector. Used for serendipity inverse-weighting, quality floor, cold-start fallback. |
| 12 | Relations graph | Filter, not similarity | AniList `relations` | Exclude sequels/prequels from "discover" recs unless prior watched. |

**v1 must also implement the following recommender-theory features (committed, no gaps):**

- **Cosine similarity** as the core comparison
- **Serendipity boost** — sample top-N candidates with inverse-popularity weighting + cross-genre bridging
- **Diversity** — re-rank to spread across studios / eras / genres in the result set
- **Cold start** — onboarding quiz ("pick 5 anime you've loved") + popularity fallback
- **Explainability** — every rec shows "Why this?" with the strongest contributing signal
- **Implicit feedback** — episodes watched, drops, completions, rewatches all feed back into the taste vector
- **Negative signals** — dropped anime push the user's vector *away* from those points
- **Re-ranking pass** — filter franchise duplicates, enforce diversity, apply quality floor
- **Matrix factorization (SVD)** for collaborative filtering, when community grows large enough
- **Community-curated AniList recommendations** ingested as one additional signal

### What each theory feature actually does

So future-you doesn't have to look these up:

**Cosine similarity** — the core math: `cos(θ) = (A·B) / (|A|·|B|)`. Two vectors pointing in similar directions score close to 1; opposite directions score close to -1. Cheap to compute. Used everywhere similarity is needed.

**Serendipity** — the "surprise" factor. After ranking by similarity, don't just take the top 10. Take the top 100, then sample 10 weighted by *inverse* popularity (less-watched titles get a boost) and *cross-genre bridging* (titles with high synopsis similarity but different genre tags get a boost). This is what makes the system feel intelligent vs predictable. Without it, every rec is "more of the same."

**Diversity** — top 10 recs shouldn't all be from Studio Ghibli or all from 2020. After the similarity ranking, enforce variety rules: max N items per studio, per genre, per decade. If a result violates the rule, drop it and pull the next candidate from the ranked list. Different from serendipity — diversity is about *result-set composition*, serendipity is about *individual item unexpectedness*.

**Cold start** — two flavors:
- New user (no ratings): show an onboarding quiz ("pick 5 anime you've loved"), use those to seed a taste vector. Fall back to popularity-by-genre while the quiz hasn't been completed.
- New anime (no community ratings yet): rely purely on content + embedding signals; skip the collaborative-filtering signal for that anime.

**Explainability** — every recommendation shows "Why this?" with the strongest contributing signal. Examples: "Recommended because you loved Mushishi — similar synopsis (vector distance 0.12) and same studio (Artland)." Embedding-based systems are easier to explain than pure matrix factorization, because we can surface the nearest neighbor that drove the rec.

**Implicit feedback** — most users will never rate an anime. So we use *behavior*: episodes watched, completion rate, rewatch count, drop status, time-on-page. Each gets a weight and feeds into the user's taste vector. The old project had columns for some of this (`episodes_watched`, `rewatched`) and never used them.

**Negative signals** — "I dropped this at episode 3" is data. Push the user's taste vector *away* from the vectors of dropped or low-rated anime, not just toward what they liked. Mathematically: subtract a weighted version of the disliked anime's vector during taste-vector calculation.

**Re-ranking pass** — after initial similarity ranking, apply a final filter pass: no same-franchise duplicates (excluded via the relations graph), no anime the user already watched, no anime above their length tolerance, diversity rules from above, quality floor (mean score above a threshold). This is where human judgment lives, encoded as rules.

**Matrix factorization (SVD)** — proper collaborative filtering. Build a sparse user×anime ratings matrix, decompose it into low-dimensional latent factors (typically 20-50 dimensions), then predict an unrated cell as the dot product of its row's and column's latent vectors. Only meaningful once the community has hundreds of users with overlapping ratings. Use a JS lib or numpy via WASM. Runs as a periodic batch job, not per-request.

**Community-curated AniList recommendations** — AniList users submit "if you liked X, watch Y" pairings; these are publicly available via the API. Ingest them as one signal among many — items the community already curated get a small boost. Free signal, high quality, captures human judgment our model can't.

**v2 (deferred but planned — three signals):**

| # | Signal | Form | Source | Why deferred |
| --- | --- | --- | --- | --- |
| 13 | LLM tone tagging | Categorical (humor style, mood, intensity) | Claude / local LLM | Massively improves faceted search, but adds API call / local-LLM ops complexity. Pennies for the catalog. |
| 14 | Vision embeddings | CLIP vector from key frames | Scraped thumbnails | "Find similar animation style." Needs an image pipeline; real ML cost. |
| 15 | Time decay on ratings | Weighted history | User watch log | Only meaningful after a year of user data. |

**Explicitly excluded (do not add without revisiting):**

- **Title** — mostly noise (stylized romanizations); synopsis already covers it
- **Voice actors / directors / composers individually** — sparse, niche, fold into studio similarity
- **Streaming availability** — no clean API; scraping is fragile and ToS-exposed
- **External scraping** (MAL forums, Reddit, Twitter) — scraping debt, low marginal value
- **Awards** — correlate with mean score; captured implicitly
- **Audio embeddings from OSTs** — niche payoff, massive complexity
- **Social graph** — doesn't fit a private tracker

### Querying

The user is exposed to **faceted weighting** in the UI — sliders for "similar story / similar characters / similar tone / similar style." The query is a weighted sum of cosine similarities across signal types, computed in SQL via `sqlite-vec`.

### Comment discipline

Each function in `src/recommender.js` must have a comment block explaining
what it computes, when it's called, what its fallback is, and which signal
columns it reads from.

## What the user wants from you (AI)

- **Plain-English explanations alongside code.** The user is learning.
- **Push back on unnecessary complexity.** If something can wait until v2, say so.
- **When asked to add something, ask: "do we need this in v1, or is this v2?"**
- **Slow, clear, correct beats fast and clever.**
- **Ask before big decisions.** Anything that touches more than ~50 lines, defines schema/architecture/API surface, or locks in a non-obvious trade-off: pause and ask first. Show what you're about to do as the next concrete step, get approval, then write.
- The user has a 2-month, after-hours timeline. Don't over-scope.

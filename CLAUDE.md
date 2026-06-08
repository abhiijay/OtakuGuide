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

## Current state (last updated 2026-06-08)

**Scaffold is up.** `npm run dev` boots a working Express+EJS server with compiled Tailwind. Smoke-test page at `/` renders sakura-red text confirming Tailwind is wired.

Files on disk:
- `README.md`, `CLAUDE.md` — documentation
- `package.json` — deps: express, ejs, dotenv (prod) + tailwindcss, nodemon, concurrently (dev). Six npm scripts.
- `.env.example`, `.gitignore`
- `server.js` — 25 lines, boots Express, serves static files, renders `home.ejs` at `/`
- `tailwind.config.js` — defines `sakura` (`#DC143C`), `ink`, `paper` colors + Shippori Mincho font stack
- `styles/input.css` — 3-line Tailwind source
- `views/home.ejs` — smoke-test page
- `public/css/styles.css` — compiled Tailwind output (5.4KB)

No database yet, no auth, no API routes, no real views. Just the bones.

## Where we left off (2026-06-07 night)

Cross-checked the full database schema against every commitment we made — all 12 signals, 9 theory features, data-resilience plan, auth plan, and aesthetic decisions. Identified three corrections to the original 16-table proposal:

1. Add `users.onboarding_completed_at` (cold-start support)
2. Add `anime.collab_vec` BLOB (SVD-derived item latent factor)
3. Rename `user_taste_vector` → `user_vectors`, add `collab_vec` (SVD-derived user latent factor)

**Final table count: 15** (dropped sessions — letting the session-store library manage its own table).

Tables grouped:
- Auth (2): `users`, `external_accounts`
- Catalog spine (1): `anime` (with 5 BLOB vec columns: synopsis_vec, tag_vec, character_vec, review_vec, collab_vec)
- Lookups (4): `genres`, `tags`, `studios`, `characters`
- Joins (4): `anime_genres`, `anime_tags`, `anime_studios`, `anime_characters`
- Relationships (2): `relations`, `community_recommendations`
- User tracking (2): `user_anime`, `user_vectors`

~~Open question we didn't answer: do we want `users.show_adult` column in v1?~~ **Decided 2026-06-08: no column, filter all adult titles at the query layer.** AniList's `isAdult` flag marks explicit sexual content only (hentai), not gore or violence — so legitimate dark seinen (Dorohedoro, Chainsaw Man, Berserk, Devilman Crybaby) is unaffected. Centralize the filter in `src/db.js` so we can't forget a `WHERE` clause.

## Next move

1. Install `better-sqlite3` and `sqlite-vec`
2. Write `db/schema.sql` with 15 tables, every column commented
3. Write `scripts/init-db.js` and `src/db.js` (with the adult filter centralized here)
4. Run `npm run init-db`, verify all 15 tables exist via `sqlite3 db/otakuguide.sqlite ".schema"`

## When picking back up — concrete next step

If you're returning after time away, do this in order:

1. **Re-read this whole file.** Skim the README too. Do not try to remember decisions from memory.
2. **Confirm or revise the open decisions** in the "Open decisions" section below. Anything that has changed in your thinking, update here first.
3. ~~First code to write is the file scaffold.~~ **Done 2026-06-07.** Scaffold exists, `npm run dev` boots cleanly.
4. **Next up: the database.** Write `db/schema.sql` with the 15 tables described in "Where we left off." Then `scripts/init-db.js` to execute it, then `src/db.js` to open the database and load `sqlite-vec`. Run `npm run init-db`.
5. **After that, in order:** AniList GraphQL client (`src/anilist.js`) → catalog import script → embedding pipeline → recommender engine → auth → AniList OAuth flow → JSON API → views. Don't reorder.

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
5. **First-run catalog import strategy.** Pulling ~15K anime from AniList with embeddings will take hours. Resumable batch? Background job? Cached snapshot?
6. **Build order (locked 2026-06-06):** backend first, frontend later. No rushing. The recommender engine, catalog import, schema, and API surface get done before any view files exist beyond a placeholder.

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

### Primary source: AniList

We pull anime metadata, tags, characters, reviews, and user watch lists from AniList via its GraphQL API. AniList was chosen as the primary because it has the best tag system of any anime source (community-curated, ranked, categorized — directly powering signal #2 in the recommender), modern GraphQL means single-request fetches, and structured review + character entries are essential for the character-vector and review-aggregate-vector signals.

OAuth: register an app at https://anilist.co/settings/developer. Provides `client_id` + `client_secret`. The `redirect_uri` is our callback URL (dev: `http://localhost:3000/auth/anilist/callback`). Token flow: authorization code → exchange for access token → store in `external_accounts` table.

### Secondary sources (post-v1, optional)

- **MyAnimeList via Jikan API** (https://jikan.moe) — free, 3 req/sec. Better source for: extra review text (larger user base writing them), older / obscure titles missing from AniList, bigger collaborative ratings matrix. Use as fallback when AniList lacks a field.
- **Anime-Offline-Database** (https://github.com/manami-project/anime-offline-database) — community-aggregated JSON snapshot combining MAL + AniList + Kitsu + AniDB + Notify.moe. Refreshed weekly. Local snapshot is our fallback if any single source goes down.
- **Manami ID-mapping** (same project) — AniList ↔ MAL ↔ Kitsu ↔ AniDB ID translation table. Lets us cross-reference the same anime across sources.

### Schema implications (v1)

- `anime` table has both `anilist_id` and `mal_id` columns (both nullable) from day one — supports future multi-source merging without migration.
- `external_accounts` table supports multiple providers (`provider: 'anilist' | 'mal' | ...`) — supports future OAuth providers without migration.
- The catalog import is wrapped behind a single function (`fetchAnimeMetadata(id) → AnimeData`) so the source can be swapped without touching the rest of the code.

### Resilience guarantees

If AniList disappears tomorrow:
- **The app keeps working.** All anime metadata + embeddings are stored locally in SQLite. The recommender does not make live API calls.
- **User data is safe.** Lists, ratings, progress, favorites all live in our SQLite, not AniList's.
- **New imports switch sources.** Catalog import is one function — point it at Jikan or the Offline Database.
- **Login still works.** Email/password is independent of AniList OAuth. Users can also add MAL OAuth if implemented.

What we'd lose: live sync of progress changes between OtakuGuide and the user's external AniList account (cosmetic — local data is intact).

This is ~30 minutes of forethought at schema-design time. Build it in, never need to refactor.

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
